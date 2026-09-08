import { createServer, type Server } from "node:http"
import {
	Account,
	Address,
	BASE_FEE,
	Contract,
	Keypair,
	StrKey,
	TransactionBuilder,
	rpc,
	scValToNative,
	xdr,
} from "@stellar/stellar-sdk"
import {
	ROUTERS,
	assertSafeToSponsor,
	assetsForNetwork,
	buildAuthorizeTx,
	buildClaimableBalanceDelivery,
	buildOnboardTx,
	buildSponsoredOnboardTx,
	getActivationStatus,
	defaultAllowHttp,
	type OfficialAsset,
} from "@theahaco/authline"
import { loadConfig, type RelayerConfig } from "./config.js"
import { createGate, createRateLimiter } from "./limits.js"
import { handleRequest, type ChainOps } from "./service.js"

// Re-exported so the e2e suite (and self-hosters embedding the relayer) can
// import everything from one module.
export { loadConfig, type RelayerConfig } from "./config.js"
export * from "./limits.js"
export * from "./service.js"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The real chain behind {@link ChainOps}, one RPC server per process. */
export function makeChainOps(cfg: RelayerConfig): ChainOps {
	const server = new rpc.Server(cfg.rpcUrl, {
		allowHttp: defaultAllowHttp(cfg.rpcUrl),
	})

	// Signature hint of the relayer key: the last 4 bytes of the public key.
	const relayerHint = cfg.signer.rawPublicKey().subarray(-4)

	/**
	 * Submit (signing with the relayer key first when asked), wait. Tx hash.
	 * A Case B sandwich already carries the relayer's sponsor signature from
	 * build time; signing it again would be an EXTRA signature the network
	 * rejects (`txBAD_AUTH_EXTRA`), so an existing one is left alone.
	 */
	async function submit(xdrB64: string, sign = true): Promise<string> {
		const tx = TransactionBuilder.fromXDR(xdrB64, cfg.networkPassphrase)
		const alreadySigned = tx.signatures.some((sig) =>
			Buffer.from(sig.hint()).equals(relayerHint),
		)
		if (sign && !alreadySigned) tx.sign(cfg.signer)
		const sent = await server.sendTransaction(tx)
		if (sent.status === "ERROR")
			throw new Error(
				`sendTransaction ERROR: ${sent.errorResult?.toXDR("base64") ?? "(no errorResult)"}`,
			)
		const deadline = Date.now() + 60_000
		let got = await server.getTransaction(sent.hash)
		while (got.status === "NOT_FOUND" && Date.now() < deadline) {
			await sleep(1200)
			got = await server.getTransaction(sent.hash)
		}
		if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS)
			throw new Error(
				got.status === rpc.Api.GetTransactionStatus.FAILED
					? `transaction ${sent.hash} failed: ${got.resultXdr.toXDR("base64")}`
					: `transaction ${sent.hash} not confirmed within deadline`,
			)
		return sent.hash
	}

	return {
		async view(asset: OfficialAsset, account: string) {
			const status = await getActivationStatus({
				rpcUrl: cfg.rpcUrl,
				account,
				assetCode: asset.code,
				assetIssuer: asset.issuer,
				sac: asset.sac,
				networkPassphrase: cfg.networkPassphrase,
			})
			// A missing trustline and a missing account read identically from the
			// trustline entry — read the account entry itself to tell them apart,
			// and take the XLM balance while there (it picks Case B vs C).
			let accountExists = true
			let xlmBalance: string | undefined
			if (status.holderKind === "account") {
				const key = xdr.LedgerKey.account(
					new xdr.LedgerKeyAccount({
						accountId: Keypair.fromPublicKey(account).xdrAccountId(),
					}),
				)
				const { entries } = await server.getLedgerEntries(key)
				const entry = entries[0]
				if (!entry) accountExists = false
				else
					xlmBalance = (
						Number(entry.val.account().balance().toString()) / 1e7
					).toFixed(7)
			}
			return { status, accountExists, xlmBalance }
		},

		async buildSponsoredOnboard(
			asset: OfficialAsset,
			holder: string,
			createAccount: boolean,
		) {
			const sponsor = cfg.signer.publicKey()
			const config = {
				assetCode: asset.code,
				assetIssuer: asset.issuer,
				sac: asset.sac,
				authorizer: asset.authorizer,
				router: ROUTERS[cfg.network],
				backends: ["cap33-sponsored" as const],
			}
			const unsigned = await buildSponsoredOnboardTx({
				rpcUrl: cfg.rpcUrl,
				networkPassphrase: cfg.networkPassphrase,
				sponsor,
				user: holder,
				config,
				createUserAccount: createAccount,
				source: "sponsor",
				allowHttp: defaultAllowHttp(cfg.rpcUrl),
			})
			// The ops account's own safety check before it signs anything.
			assertSafeToSponsor({
				txXdr: unsigned,
				networkPassphrase: cfg.networkPassphrase,
				sponsor,
				user: holder,
				config,
			})
			const tx = TransactionBuilder.fromXDR(unsigned, cfg.networkPassphrase)
			tx.sign(cfg.signer)
			return tx.toXDR()
		},

		async sendClaimable(
			asset: OfficialAsset,
			recipient: string,
			amount: string,
		) {
			const sender = cfg.signer.publicKey()
			const acct = await server.getAccount(sender)
			const { xdr: unsigned, balanceId } = buildClaimableBalanceDelivery({
				networkPassphrase: cfg.networkPassphrase,
				sender,
				senderSequence: acct.sequenceNumber(),
				recipient,
				amount,
				config: { assetCode: asset.code, assetIssuer: asset.issuer },
				reclaimAfterSeconds: 30 * 24 * 3600,
			})
			const txHash = await submit(unsigned, true)
			return { balanceId, txHash }
		},

		async isEligible(asset: OfficialAsset, account: string) {
			if (!asset.authorizer)
				throw new Error(`${asset.code} has no authorizer contract`)
			// Simulation ignores the sequence number, so a dummy source Account
			// (the issuer — always a funded G-account) avoids a getAccount call.
			const tx = new TransactionBuilder(new Account(asset.issuer, "0"), {
				fee: BASE_FEE,
				networkPassphrase: cfg.networkPassphrase,
			})
				.addOperation(
					new Contract(asset.authorizer).call(
						"is_eligible",
						new Address(account).toScVal(),
					),
				)
				.setTimeout(60)
				.build()
			const sim = await server.simulateTransaction(tx)
			if (!rpc.Api.isSimulationSuccess(sim) || !sim.result)
				throw new Error(
					`is_eligible simulation failed: ${"error" in sim ? sim.error : "no result"}`,
				)
			const val: unknown = scValToNative(sim.result.retval)
			if (typeof val !== "boolean")
				throw new Error(`is_eligible returned a non-boolean: ${String(val)}`)
			return val
		},

		async buildOnboard(asset: OfficialAsset, holder: string) {
			// A contract holder cannot source a transaction: the relayer is the
			// fee source and countersigns at the callback.
			const smart = StrKey.isValidContract(holder)
			return buildOnboardTx({
				rpcUrl: cfg.rpcUrl,
				networkPassphrase: cfg.networkPassphrase,
				holder,
				...(smart ? { feeSource: cfg.signer.publicKey() } : {}),
				config: {
					assetCode: asset.code,
					assetIssuer: asset.issuer,
					sac: asset.sac,
					authorizer: asset.authorizer,
					router: ROUTERS[cfg.network],
					backends: ["cap73-one-signature"],
				},
				allowHttp: defaultAllowHttp(cfg.rpcUrl),
			})
		},
		async submitSep7(xdrB64: string, countersign: boolean) {
			return submit(xdrB64, countersign)
		},
		async authorize(asset: OfficialAsset, account: string) {
			const xdrB64 = await buildAuthorizeTx({
				rpcUrl: cfg.rpcUrl,
				networkPassphrase: cfg.networkPassphrase,
				source: cfg.signer.publicKey(),
				account,
				config: {
					assetCode: asset.code,
					assetIssuer: asset.issuer,
					sac: asset.sac,
					authorizer: asset.authorizer,
					backends: [],
				},
			})
			return submit(xdrB64)
		},
	}
}

/**
 * Boot-time invariant: the relayer key must not be any pinned authorizer's
 * admin. The docs say "never"; this makes it a mechanism — a relayer started
 * with the admin key would turn a public HTTP endpoint into an admin console.
 * Fails CLOSED on a confirmed match; a chain read that fails only warns, so
 * an RPC outage cannot keep a correctly configured relayer down.
 */
export async function assertRelayerIsNotAdmin(
	cfg: RelayerConfig,
): Promise<void> {
	const server = new rpc.Server(cfg.rpcUrl, {
		allowHttp: defaultAllowHttp(cfg.rpcUrl),
	})
	const relayer = cfg.signer.publicKey()
	const regulated = assetsForNetwork(cfg.network).filter((a) => a.authorizer)
	for (const asset of regulated) {
		try {
			const tx = new TransactionBuilder(new Account(asset.issuer, "0"), {
				fee: BASE_FEE,
				networkPassphrase: cfg.networkPassphrase,
			})
				.addOperation(new Contract(asset.authorizer!).call("admin"))
				.setTimeout(60)
				.build()
			const sim = await server.simulateTransaction(tx)
			if (!rpc.Api.isSimulationSuccess(sim) || !sim.result)
				throw new Error("error" in sim ? String(sim.error) : "no result")
			const admin: unknown = scValToNative(sim.result.retval)
			if (admin === relayer)
				throw new Error(
					`RELAYER_SECRET is the ${asset.code} authorizer's ADMIN key. ` +
						"Refusing to start: the relayer must hold a low-privilege, " +
						"fee-only account. Use a dedicated ops key (see the runbook).",
				)
		} catch (e) {
			if (e instanceof Error && e.message.includes("Refusing to start")) throw e
			console.warn(
				`authline-relayer: could not verify the ${asset.code} authorizer ` +
					`admin at boot (${e instanceof Error ? e.message : String(e)}) — ` +
					"continuing, but ensure RELAYER_SECRET is a fee-only key",
			)
		}
	}
}

/** Wire {@link handleRequest} to node:http. Exported for the e2e suite. */
export function startServer(cfg: RelayerConfig, ops: ChainOps): Server {
	const limiter = createRateLimiter(cfg.rateLimitRpm ?? 120)
	const gate = createGate(cfg.maxInflight ?? 8)

	const clientIp = (req: {
		headers: Record<string, string | string[] | undefined>
		socket: { remoteAddress?: string }
	}): string => {
		if (cfg.trustProxy) {
			const fly = req.headers["fly-client-ip"]
			if (typeof fly === "string" && fly) return fly
			const fwd = req.headers["x-forwarded-for"]
			const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim()
			if (first) return first
		}
		return req.socket.remoteAddress ?? "unknown"
	}

	// The SEP-7 callback is called from the USER's browser (the wallet page),
	// so responses must be readable cross-origin. Auth is a bearer header, never
	// a cookie, so a wildcard origin gives away nothing.
	const CORS = {
		"access-control-allow-origin": "*",
		"access-control-allow-methods": "GET, POST, OPTIONS",
		"access-control-allow-headers": "authorization, content-type",
		"access-control-max-age": "600",
	}
	const BODY_LIMIT = 64 * 1024 // a prepared Soroban envelope is a few KB

	const server = createServer((req, res) => {
		const send = (status: number, body: Record<string, unknown>) => {
			res.writeHead(status, { "content-type": "application/json", ...CORS })
			res.end(JSON.stringify(body))
		}
		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "x"}`)

		if (req.method === "OPTIONS") {
			res.writeHead(204, CORS)
			return res.end()
		}

		// /healthz is a static answer — platform health checks must never be
		// rate-limited or queued behind chain work.
		if (url.pathname !== "/healthz") {
			if (!limiter.allow(clientIp(req)))
				return send(429, {
					error: "rate_limited",
					detail: "per-IP request budget exhausted — retry shortly",
				})
			if (!gate.enter())
				return send(503, {
					error: "too_busy",
					detail: "relayer at capacity — retry with backoff",
				})
			res.once("close", () => gate.leave())
		}

		const auth = req.headers.authorization
		const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined

		// Read the body only for POSTs, bounded.
		const chunks: Buffer[] = []
		let size = 0
		let tooLarge = false
		req.on("data", (c: Buffer) => {
			size += c.length
			if (size > BODY_LIMIT) {
				tooLarge = true
				req.destroy()
				return
			}
			chunks.push(c)
		})
		req.on("end", () => {
			if (tooLarge)
				return send(413, { error: "too_large", detail: "body over 64 KiB" })
			const text = Buffer.concat(chunks).toString("utf8")
			const ct = req.headers["content-type"]
			handleRequest(cfg, ops, req.method ?? "GET", url, bearer, {
				contentType: Array.isArray(ct) ? ct[0] : ct,
				text,
			})
				.then(({ status, body, text }) => {
					if (text) {
						res.writeHead(status, { "content-type": text.contentType, ...CORS })
						return res.end(text.content)
					}
					send(status, body)
				})
				.catch((e: unknown) => {
					// The message stays with the operator; callers get a generic
					// detail — internal errors can name RPC endpoints or libraries.
					console.error(
						"authline-relayer: unhandled error:",
						e instanceof Error ? e.message : String(e),
					)
					send(500, { error: "internal", detail: "internal error" })
				})
		})
	})
	server.listen(cfg.port, cfg.host ?? "0.0.0.0")
	return server
}

// Entry point: `node dist/server.js` (skipped when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
	const cfg = loadConfig(process.env)
	await assertRelayerIsNotAdmin(cfg)
	startServer(cfg, makeChainOps(cfg))
	console.log(
		`authline-relayer listening on ${cfg.host ?? "0.0.0.0"}:${cfg.port} — ` +
			`network ${cfg.network}, relayer account ${cfg.signer.publicKey()}, ` +
			`default asset ${cfg.defaultAsset}, ` +
			`rate limit ${cfg.rateLimitRpm ?? 120}/min/IP, ` +
			`max in-flight ${cfg.maxInflight ?? 8}, ` +
			`SEP-7 callback ${cfg.allowSep7Callback ? "on" : "off"}, ` +
			`SEP-7 requests ${cfg.sep7OriginDomain ? `signed as ${cfg.sep7OriginDomain}` : "UNSIGNED (set SEP7_ORIGIN_DOMAIN)"}`,
	)
}
