import {
	Account,
	Address,
	Asset,
	BASE_FEE,
	Contract,
	Keypair,
	Operation,
	StrKey,
	TransactionBuilder,
	nativeToScVal,
	xdr,
} from "@stellar/stellar-sdk"
import {
	ROUTERS,
	parseSep7TxRequest,
	resolveOfficialAsset,
	verifySep7Signature,
	type ActivationStatus,
} from "@theahaco/authline"
import { describe, expect, it } from "vitest"
import { type RelayerConfig } from "./config.js"
import {
	computeReady,
	diagnoseCase,
	explainChainError,
	handleRequest,
	parseSep7CallbackBody,
	stellarToml,
	validateSep7Callback,
	type AccountView,
	type ChainOps,
} from "./service.js"

// The pinned testnet assets: EURCV is regulated (has an authorizer), USDC is
// open. The relayer's behavior forks on exactly that distinction.
const EURCV = resolveOfficialAsset("EURCV", "TESTNET")!
const USDC = resolveOfficialAsset("USDC", "TESTNET")

const HOLDER = Keypair.random().publicKey()

const SIGNER = Keypair.random()
const cfg: RelayerConfig = {
	network: "TESTNET",
	networkPassphrase: "Test SDF Network ; September 2015",
	rpcUrl: "https://soroban-testnet.stellar.org",
	signer: SIGNER,
	port: 0,
	defaultAsset: "EURCV",
	sep7Signer: SIGNER,
	sep7PublicUrl: "https://relay.example",
	sep7HandlerBase: "https://authline.io/app.html",
}

const gStatus = (over: Partial<ActivationStatus> = {}): ActivationStatus => ({
	holderKind: "account",
	hasTrustline: false,
	isAuthorized: false,
	isAuthorizedToMaintainLiabilities: false,
	...over,
})

const view = (
	status: ActivationStatus,
	accountExists = true,
	xlmBalance?: string,
): AccountView => ({
	status,
	accountExists,
	...(xlmBalance !== undefined ? { xlmBalance } : {}),
})

/** ChainOps stub: every method rejects unless overridden. */
const ops = (over: Partial<ChainOps>): ChainOps => ({
	view: () => Promise.reject(new Error("view not stubbed")),
	isEligible: () => Promise.reject(new Error("isEligible not stubbed")),
	authorize: () => Promise.reject(new Error("authorize not stubbed")),
	buildOnboard: () => Promise.reject(new Error("buildOnboard not stubbed")),
	submitSep7: () => Promise.reject(new Error("submitSep7 not stubbed")),
	buildSponsoredOnboard: () =>
		Promise.reject(new Error("buildSponsoredOnboard not stubbed")),
	sendClaimable: () => Promise.reject(new Error("sendClaimable not stubbed")),
	...over,
})

const GET = (path: string, o?: Partial<ChainOps>, token?: string) =>
	handleRequest(cfg, ops(o ?? {}), "GET", new URL(`http://x${path}`), token)
const POST = (path: string, o?: Partial<ChainOps>, token?: string) =>
	handleRequest(cfg, ops(o ?? {}), "POST", new URL(`http://x${path}`), token)

describe("computeReady", () => {
	it("regulated G-account: needs trustline AND the AUTHORIZED flag", () => {
		expect(computeReady(EURCV, view(gStatus(), false))).toEqual({
			ready: false,
			reason: "no_account",
		})
		expect(computeReady(EURCV, view(gStatus()))).toEqual({
			ready: false,
			reason: "no_trustline",
		})
		expect(computeReady(EURCV, view(gStatus({ hasTrustline: true })))).toEqual({
			ready: false,
			reason: "trustline_unauthorized",
		})
		expect(
			computeReady(
				EURCV,
				view(gStatus({ hasTrustline: true, isAuthorized: true })),
			),
		).toEqual({ ready: true })
	})

	it("open asset: a bare trustline is ready", () => {
		expect(USDC).not.toBeNull()
		expect(computeReady(USDC!, view(gStatus({ hasTrustline: true })))).toEqual({
			ready: true,
		})
	})

	it("contract holder: the SAC's authorized() view is the only signal", () => {
		const c = (sacAuthorized?: boolean): ActivationStatus =>
			gStatus({ holderKind: "contract", sacAuthorized })
		expect(computeReady(EURCV, view(c(true)))).toEqual({ ready: true })
		expect(computeReady(EURCV, view(c(false)))).toEqual({
			ready: false,
			reason: "not_authorized",
		})
		// An unreadable SAC view must NOT report ready.
		expect(computeReady(EURCV, view(c(undefined))).ready).toBe(false)
	})
})

describe("explainChainError", () => {
	it("maps the authorizer's typed refusals to stable HTTP errors", () => {
		const cases: Array<[number, number, string]> = [
			[1, 403, "account_banned"],
			[2, 403, "account_not_allowed"],
			[3, 409, "no_trustline"],
			[4, 503, "authorizer_paused"],
		]
		for (const [code, status, error] of cases) {
			const r = explainChainError(
				new Error(`host invocation failed: Error(Contract, #${code})`),
			)
			expect([r.status, r.body.error]).toEqual([status, error])
		}
	})

	it("passes anything untyped through as a 502", () => {
		const r = explainChainError(new Error("rpc timeout"))
		expect(r.status).toBe(502)
		expect(r.body.error).toBe("chain_error")
	})
})

describe("routing and validation", () => {
	it("healthz names the network and the relayer account", async () => {
		const r = await GET("/healthz")
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({
			ok: true,
			network: "TESTNET",
			relayer: cfg.signer.publicKey(),
		})
	})

	it("rejects a malformed account before touching the chain", async () => {
		const r = await GET("/v1/accounts/not-an-address/ready")
		expect([r.status, r.body.error]).toEqual([400, "invalid_account"])
	})

	it("rejects an unpinned asset code", async () => {
		const r = await GET(`/v1/accounts/${HOLDER}/ready?asset=DOGE`)
		expect([r.status, r.body.error]).toEqual([404, "unknown_asset"])
	})

	it("404s unknown routes and 405s wrong methods", async () => {
		expect((await GET("/v1/nope")).status).toBe(404)
		expect((await POST(`/v1/accounts/${HOLDER}/ready`)).status).toBe(405)
		expect((await GET(`/v1/accounts/${HOLDER}/authorize`)).status).toBe(405)
	})
})

describe("GET /ready", () => {
	it("reports an unauthorized trustline with authorizable from policy", async () => {
		const r = await GET(`/v1/accounts/${HOLDER}/ready`, {
			view: () => Promise.resolve(view(gStatus({ hasTrustline: true }))),
			isEligible: () => Promise.resolve(true),
		})
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({
			asset: "EURCV",
			regulated: true,
			ready: false,
			reason: "trustline_unauthorized",
			authorizable: true,
		})
	})

	it("omits authorizable when the policy read fails, rather than guessing", async () => {
		const r = await GET(`/v1/accounts/${HOLDER}/ready`, {
			view: () => Promise.resolve(view(gStatus({ hasTrustline: true }))),
			isEligible: () => Promise.reject(new Error("rpc down")),
		})
		expect(r.status).toBe(200)
		expect(r.body).not.toHaveProperty("authorizable")
	})

	it("does not consult policy for a ready account", async () => {
		const r = await GET(`/v1/accounts/${HOLDER}/ready`, {
			view: () =>
				Promise.resolve(
					view(gStatus({ hasTrustline: true, isAuthorized: true })),
				),
			// isEligible left unstubbed: calling it would reject the request.
		})
		expect(r.body).toMatchObject({ ready: true })
	})
})

describe("POST /authorize", () => {
	const unauthorized = () =>
		Promise.resolve(view(gStatus({ hasTrustline: true })))

	it("refuses an open asset outright", async () => {
		const r = await POST(`/v1/accounts/${HOLDER}/authorize?asset=USDC`)
		expect([r.status, r.body.error]).toEqual([400, "asset_not_regulated"])
	})

	it("submits and returns the tx hash", async () => {
		const r = await POST(`/v1/accounts/${HOLDER}/authorize`, {
			view: unauthorized,
			authorize: () => Promise.resolve("abc123"),
		})
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({
			authorized: true,
			alreadyAuthorized: false,
			txHash: "abc123",
		})
	})

	it("is idempotent: an already-authorized account short-circuits", async () => {
		const r = await POST(`/v1/accounts/${HOLDER}/authorize`, {
			view: () =>
				Promise.resolve(
					view(gStatus({ hasTrustline: true, isAuthorized: true })),
				),
			// authorize left unstubbed: submitting would reject the request.
		})
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({ authorized: true, alreadyAuthorized: true })
	})

	it("surfaces a denylist refusal as 403 account_banned", async () => {
		const r = await POST(`/v1/accounts/${HOLDER}/authorize`, {
			view: unauthorized,
			authorize: () =>
				Promise.reject(new Error("simulation: Error(Contract, #1)")),
		})
		expect([r.status, r.body.error]).toEqual([403, "account_banned"])
	})

	it("coalesces concurrent authorizes for one account into one submission", async () => {
		// The idempotency check is check-then-act; without coalescing, a burst
		// of identical requests would each pass it and each spend fees.
		const account = Keypair.random().publicKey()
		let submissions = 0
		let release!: (hash: string) => void
		const o: Partial<ChainOps> = {
			view: unauthorized,
			authorize: () => {
				submissions += 1
				return new Promise<string>((r) => {
					release = r
				})
			},
		}
		const [a, b] = [
			POST(`/v1/accounts/${account}/authorize`, o),
			POST(`/v1/accounts/${account}/authorize`, o),
		]
		// Let both requests reach the in-flight map before resolving.
		await new Promise((r) => setImmediate(r))
		release("txhash1")
		const [ra, rb] = await Promise.all([a, b])
		expect(submissions).toBe(1)
		expect(ra.body).toMatchObject({ authorized: true, txHash: "txhash1" })
		expect(rb.body).toMatchObject({ authorized: true, txHash: "txhash1" })

		// The key is released afterwards: a later authorize submits again.
		const later = await POST(`/v1/accounts/${account}/authorize`, {
			view: unauthorized,
			authorize: () => {
				submissions += 1
				return Promise.resolve("txhash2")
			},
		})
		expect(submissions).toBe(2)
		expect(later.body).toMatchObject({ txHash: "txhash2" })
	})

	it("enforces the bearer token only when one is configured", async () => {
		const tokenCfg = { ...cfg, apiToken: "s3cret" }
		const call = (token?: string) =>
			handleRequest(
				tokenCfg,
				ops({
					view: unauthorized,
					authorize: () => Promise.resolve("h"),
				}),
				"POST",
				new URL(`http://x/v1/accounts/${HOLDER}/authorize`),
				token,
			)
		expect((await call(undefined)).status).toBe(401)
		expect((await call("wrong")).status).toBe(401)
		expect((await call("s3cret")).status).toBe(200)
		// GET /ready stays open — reads are free and unauthenticated.
		const read = await handleRequest(
			tokenCfg,
			ops({ view: unauthorized, isEligible: () => Promise.resolve(true) }),
			"GET",
			new URL(`http://x/v1/accounts/${HOLDER}/ready`),
		)
		expect(read.status).toBe(200)
	})
})

// ── SEP-7 callback receiver ──────────────────────────────────────────
const SMART = "CDVVAQAQ4FKQ4DCPPIIOIAOPRJJBO6HVOXRQX3PXONJVJNNK432O6HW3"
const ROUTER = ROUTERS.TESTNET!

/** An `onboard(sac, holder)` envelope as a smart wallet would return it. */
function onboardXdr(o: {
	source?: string
	sac?: string
	holder?: string
	contract?: string
	fn?: string
	fee?: string
	authFor?: string | "source" | null
	extraOp?: boolean
	opSource?: string
	/** Sign the envelope with this keypair (a holder-sourced request). */
	signWith?: Keypair
}): string {
	const source = o.source ?? cfg.signer.publicKey()
	const holder = o.holder ?? SMART
	const sac = o.sac ?? EURCV.sac
	const contract = o.contract ?? ROUTER
	const fn = o.fn ?? "onboard"
	const args = [new Address(sac).toScVal(), new Address(holder).toScVal()]
	const b = new TransactionBuilder(new Account(source, "5"), {
		fee: o.fee ?? BASE_FEE,
		networkPassphrase: cfg.networkPassphrase,
	}).addOperation(
		o.opSource
			? Operation.invokeHostFunction({
					func: xdr.HostFunction.hostFunctionTypeInvokeContract(
						new xdr.InvokeContractArgs({
							contractAddress: new Address(contract).toScAddress(),
							functionName: fn,
							args,
						}),
					),
					source: o.opSource,
				})
			: new Contract(contract).call(fn, ...args),
	)
	if (o.extraOp)
		b.addOperation(
			Operation.payment({
				destination: HOLDER,
				asset: Asset.native(),
				amount: "1",
			}),
		)
	const tx = b.setTimeout(60).build()
	const env = tx.toEnvelope()
	const invocation = new xdr.SorobanAuthorizedInvocation({
		function:
			xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
				new xdr.InvokeContractArgs({
					contractAddress: new Address(contract).toScAddress(),
					functionName: fn,
					args: [new Address(sac).toScVal(), new Address(holder).toScVal()],
				}),
			),
		subInvocations: [],
	})
	const authFor = o.authFor === undefined ? holder : o.authFor
	if (authFor !== null) {
		const creds =
			authFor === "source"
				? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
				: xdr.SorobanCredentials.sorobanCredentialsAddress(
						new xdr.SorobanAddressCredentials({
							address: new Address(authFor).toScAddress(),
							nonce: xdr.Int64.fromString("1"),
							signatureExpirationLedger: 0,
							signature: nativeToScVal(null),
						}),
					)
		env
			.v1()
			.tx()
			.operations()[0]
			.body()
			.invokeHostFunctionOp()
			.auth([
				new xdr.SorobanAuthorizationEntry({
					credentials: creds,
					rootInvocation: invocation,
				}),
			])
	}
	if (o.signWith) {
		const signedTx = TransactionBuilder.fromXDR(
			env.toXDR("base64"),
			cfg.networkPassphrase,
		)
		signedTx.sign(o.signWith)
		return signedTx.toXDR()
	}
	return env.toXDR("base64")
}

describe("validateSep7Callback — the callback's whole security boundary", () => {
	it("accepts exactly the buildOnboardTx smart-account shape (relayer countersigns)", () => {
		const r = validateSep7Callback(cfg, onboardXdr({}))
		expect(r).toEqual({
			asset: EURCV,
			holder: SMART,
			countersign: true,
			kind: "onboard",
		})
	})

	it("accepts a G-holder onboarded via the relayer as fee source", () => {
		const r = validateSep7Callback(cfg, onboardXdr({ holder: HOLDER }))
		expect(r).toEqual({
			asset: EURCV,
			holder: HOLDER,
			countersign: true,
			kind: "onboard",
		})
	})

	it("accepts a HOLDER-sourced envelope once the wallet signed it — submit only", () => {
		const kp = Keypair.random()
		const r = validateSep7Callback(
			cfg,
			onboardXdr({
				source: kp.publicKey(),
				holder: kp.publicKey(),
				authFor: "source",
				signWith: kp,
			}),
		)
		expect(r).toEqual({
			asset: EURCV,
			holder: kp.publicKey(),
			countersign: false,
			kind: "onboard",
		})
	})

	it("refuses a holder-sourced envelope with no signature yet", () => {
		const kp = Keypair.random()
		const r = validateSep7Callback(
			cfg,
			onboardXdr({
				source: kp.publicKey(),
				holder: kp.publicKey(),
				authFor: "source",
			}),
		)
		expect(r).toMatchObject({ status: 400 })
		expect(
			String((r as unknown as { body: { detail: string } }).body.detail),
		).toMatch(/no signature/)
	})

	const refuses = (name: string, xdrB64: string, re: RegExp) =>
		it(`refuses ${name}`, () => {
			const r = validateSep7Callback(cfg, xdrB64)
			expect(r).toMatchObject({
				status: 400,
				body: { error: "not_countersignable" },
			})
			expect(
				String((r as unknown as { body: { detail: string } }).body.detail),
			).toMatch(re)
		})

	refuses("garbage", "AAAA", /not a transaction envelope/)
	refuses(
		"a transaction sourced by someone else",
		onboardXdr({ source: Keypair.random().publicKey() }),
		/sourced by the holder or by the relayer/,
	)
	refuses("a second operation", onboardXdr({ extraOp: true }), /exactly one/)
	refuses(
		"a different contract",
		onboardXdr({ contract: EURCV.authorizer! }),
		/onboard\(sac, holder\)/,
	)
	refuses("a different function", onboardXdr({ fn: "trust" }), /onboard/)
	refuses(
		"an unpinned SAC",
		onboardXdr({
			sac: StrKey.encodeContract(Buffer.alloc(32, 7)),
		}),
		/not a pinned asset/,
	)
	refuses(
		"the relayer as its own holder",
		onboardXdr({ holder: cfg.signer.publicKey(), authFor: null }),
		/cannot be the relayer/,
	)
	refuses(
		"SOURCE-ACCOUNT credentials (the relayer's signature would authorize)",
		onboardXdr({ authFor: "source" }),
		/source-account credentials/,
	)
	refuses(
		"an auth entry for another address",
		onboardXdr({ authFor: Keypair.random().publicKey() }),
		/holder's own address/,
	)
	refuses(
		"an op naming another source",
		onboardXdr({ opSource: Keypair.random().publicKey() }),
		/another source/,
	)
	refuses("a fee above the cap", onboardXdr({ fee: "5000001" }), /exceeds/)

	it("respects a configured fee cap", () => {
		const tight: RelayerConfig = { ...cfg, sep7MaxFeeStroops: 50 }
		expect(validateSep7Callback(tight, onboardXdr({}))).toMatchObject({
			status: 400,
		})
	})
})

describe("parseSep7CallbackBody", () => {
	it("reads the form-encoded xdr field SEP-7 specifies, or JSON", () => {
		expect(
			parseSep7CallbackBody("application/x-www-form-urlencoded", "xdr=AAAA%3D"),
		).toBe("AAAA=")
		expect(parseSep7CallbackBody("application/json", '{"xdr":"BBBB"}')).toBe(
			"BBBB",
		)
		expect(parseSep7CallbackBody(undefined, "xdr=CCCC")).toBe("CCCC")
		expect(parseSep7CallbackBody("application/json", "{")).toMatchObject({
			status: 400,
		})
		expect(parseSep7CallbackBody(undefined, "nothing=here")).toMatchObject({
			status: 400,
		})
	})
})

describe("POST /v1/sep7/callback", () => {
	const on: RelayerConfig = { ...cfg, allowSep7Callback: true }
	const post = (
		o: Partial<ChainOps>,
		body = `xdr=${encodeURIComponent(onboardXdr({}))}`,
		c = on,
	) =>
		handleRequest(
			c,
			ops(o),
			"POST",
			new URL("http://x/v1/sep7/callback"),
			undefined,
			{
				contentType: "application/x-www-form-urlencoded",
				text: body,
			},
		)

	it("is absent unless enabled, and advertised on /healthz when it is", async () => {
		const off = await post({}, undefined, cfg)
		expect(off.status).toBe(404)
		const h = await handleRequest(
			on,
			ops({}),
			"GET",
			new URL("http://x/healthz"),
		)
		expect(h.body.sep7Callback).toBe("/v1/sep7/callback")
		const h2 = await handleRequest(
			cfg,
			ops({}),
			"GET",
			new URL("http://x/healthz"),
		)
		expect(h2.body.sep7Callback).toBeUndefined()
	})

	it("countersigns and submits a valid envelope — no bearer token needed", async () => {
		let signed: string | undefined
		const r = await post({
			view: async () =>
				view(gStatus({ holderKind: "contract", sacAuthorized: false })),
			submitSep7: async (x: string, countersign: boolean) => {
				expect(countersign).toBe(true)
				signed = x
				return "deadbeef"
			},
		})
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({
			account: SMART,
			asset: "EURCV",
			authorized: true,
			alreadyAuthorized: false,
			txHash: "deadbeef",
		})
		expect(signed).toBe(onboardXdr({}))
	})

	it("submits a holder-sourced envelope WITHOUT countersigning", async () => {
		const kp = Keypair.random()
		let countersigned: boolean | undefined
		const r = await post(
			{
				view: async () => view(gStatus({ hasTrustline: false })),
				submitSep7: async (_x: string, c: boolean) => {
					countersigned = c
					return "cafe"
				},
			},
			`xdr=${encodeURIComponent(
				onboardXdr({
					source: kp.publicKey(),
					holder: kp.publicKey(),
					authFor: "source",
					signWith: kp,
				}),
			)}`,
		)
		expect(r.body).toMatchObject({ account: kp.publicKey(), txHash: "cafe" })
		expect(countersigned).toBe(false)
	})

	it("is idempotent: an already-authorized holder costs no signature", async () => {
		const r = await post({
			view: async () =>
				view(gStatus({ holderKind: "contract", sacAuthorized: true })),
		})
		expect(r.body).toMatchObject({ alreadyAuthorized: true })
	})

	it("refuses a foreign envelope before touching the chain", async () => {
		const r = await post(
			{},
			`xdr=${encodeURIComponent(onboardXdr({ source: Keypair.random().publicKey() }))}`,
		)
		expect(r.status).toBe(400)
		expect(r.body.error).toBe("not_countersignable")
	})

	it("maps a contract refusal on submit to the typed HTTP error", async () => {
		const r = await post({
			view: async () =>
				view(gStatus({ holderKind: "contract", sacAuthorized: false })),
			submitSep7: async () => {
				throw new Error("HostError: Error(Contract, #1)")
			},
		})
		expect(r).toMatchObject({ status: 403, body: { error: "account_banned" } })
	})
})

describe("GET /.well-known/stellar.toml", () => {
	it("publishes the SEP-7 signing key for origin_domain verification", async () => {
		const r = await handleRequest(
			cfg,
			ops({}),
			"GET",
			new URL("http://x/.well-known/stellar.toml"),
		)
		expect(r.status).toBe(200)
		expect(r.text?.contentType).toMatch(/text\/plain/)
		expect(r.text?.content).toContain(
			`URI_REQUEST_SIGNING_KEY="${SIGNER.publicKey()}"`,
		)
		expect(stellarToml(cfg)).toContain(cfg.networkPassphrase)
	})
})

describe("POST /v1/sep7/request — the integrator side", () => {
	const signedCfg: RelayerConfig = { ...cfg, sep7OriginDomain: "relay.example" }
	const request = (body: unknown, o: Partial<ChainOps>, c = signedCfg) =>
		handleRequest(
			c,
			ops(o),
			"POST",
			new URL("http://x/v1/sep7/request"),
			undefined,
			{
				contentType: "application/json",
				text: typeof body === "string" ? body : JSON.stringify(body),
			},
		)

	it("emits a SIGNED, verifiable request with callback + receiving-page link", async () => {
		const holderXdr = onboardXdr({
			source: HOLDER,
			holder: HOLDER,
			authFor: "source",
		})
		const r = await request(
			{ account: HOLDER, asset: "EURCV", msg: "Northwind: activate EURCV" },
			{
				view: async () => view(gStatus({ hasTrustline: false })),
				buildOnboard: async () => holderXdr,
			},
		)
		expect(r.status).toBe(200)
		const b = r.body as {
			sep7Uri: string
			handlerUrl: string
			callback: string
			signed: boolean
			originDomain: string
		}
		expect(b.signed).toBe(true)
		expect(b.originDomain).toBe("relay.example")
		expect(b.callback).toBe("https://relay.example/v1/sep7/callback")
		expect(b.handlerUrl.startsWith("https://authline.io/app.html?sep7=")).toBe(
			true,
		)
		const parsed = parseSep7TxRequest(b.sep7Uri, {
			networkPassphrase: cfg.networkPassphrase,
		})
		expect(parsed.xdr).toBe(holderXdr)
		expect(parsed.callback).toBe(b.callback)
		expect(parsed.msg).toBe("Northwind: activate EURCV")
		expect(parsed.originDomain).toBe("relay.example")
		// The wallet's check: the signature matches the key our toml publishes.
		expect(verifySep7Signature(b.sep7Uri, SIGNER.publicKey())).toBe(true)
	})

	it("goes out unsigned (and says so) when no origin domain is configured", async () => {
		const r = await request(
			{ account: HOLDER },
			{
				view: async () => view(gStatus({ hasTrustline: false })),
				buildOnboard: async () =>
					onboardXdr({ source: HOLDER, holder: HOLDER, authFor: "source" }),
			},
			cfg,
		)
		expect(r.body).toMatchObject({ signed: false, originDomain: null })
		expect(
			parseSep7TxRequest((r.body as { sep7Uri: string }).sep7Uri).signature,
		).toBeUndefined()
	})

	it("builds a relayer-fee-sourced request for a smart-account holder", async () => {
		let built: string | undefined
		const r = await request(
			{ account: SMART },
			{
				view: async () =>
					view(gStatus({ holderKind: "contract", sacAuthorized: false })),
				buildOnboard: async (_a, holder) => {
					built = holder
					return onboardXdr({})
				},
			},
		)
		expect(r.status).toBe(200)
		expect(built).toBe(SMART)
	})

	it("short-circuits for an account that is already ready", async () => {
		const r = await request(
			{ account: HOLDER },
			{
				view: async () =>
					view(gStatus({ hasTrustline: true, isAuthorized: true })),
			},
		)
		expect(r.body).toMatchObject({ alreadyAuthorized: true })
		expect(r.body.sep7Uri).toBeUndefined()
	})

	it("refuses a bad body, a bad address, and the relayer itself", async () => {
		expect((await request("{", {})).status).toBe(400)
		expect((await request({ account: "nope" }, {})).body).toMatchObject({
			error: "invalid_account",
		})
		expect((await request({ account: SIGNER.publicKey() }, {})).status).toBe(
			400,
		)
		expect((await request({ account: HOLDER, asset: "NOPE" }, {})).status).toBe(
			404,
		)
	})
})

// ── Case diagnosis + Case B (sponsored) + claimable delivery ─────────
describe("diagnoseCase", () => {
	it("maps ledger state to the SEP's cases", () => {
		expect(diagnoseCase(EURCV, view(gStatus(), false))).toEqual({
			case: "B",
			createAccount: true,
		})
		expect(diagnoseCase(EURCV, view(gStatus(), true, "1.2000000"))).toEqual({
			case: "B",
			createAccount: false,
		})
		expect(diagnoseCase(EURCV, view(gStatus(), true, "25.0000000"))).toEqual({
			case: "C",
			createAccount: false,
		})
		// Balance unknown → assume funded (the CAP-73 build fails loudly if not).
		expect(diagnoseCase(EURCV, view(gStatus()))).toMatchObject({ case: "C" })
		expect(
			diagnoseCase(EURCV, view(gStatus({ hasTrustline: true }))),
		).toMatchObject({ case: "A" })
		expect(
			diagnoseCase(
				EURCV,
				view(gStatus({ hasTrustline: true, isAuthorized: true })),
			),
		).toMatchObject({ case: "ready" })
		expect(
			diagnoseCase(EURCV, view(gStatus({ holderKind: "contract" }))),
		).toMatchObject({ case: "C" })
	})
})

/** The CAP-33 sandwich `buildSponsoredOnboardTx` emits, signed as asked. */
function sponsoredXdr(o: {
	holder: Keypair
	sponsor?: string
	createAccount?: boolean
	asset?: { code: string; issuer: string }
	signHolder?: boolean
	signSponsor?: boolean
	extraOp?: boolean
}): string {
	const sponsor = o.sponsor ?? cfg.signer.publicKey()
	const holder = o.holder.publicKey()
	const a = o.asset ?? { code: EURCV.code, issuer: EURCV.issuer }
	const b = new TransactionBuilder(new Account(sponsor, "9"), {
		fee: BASE_FEE,
		networkPassphrase: cfg.networkPassphrase,
	}).addOperation(
		Operation.beginSponsoringFutureReserves({ sponsoredId: holder }),
	)
	if (o.createAccount)
		b.addOperation(
			Operation.createAccount({ destination: holder, startingBalance: "0" }),
		)
	b.addOperation(
		Operation.changeTrust({
			asset: new Asset(a.code, a.issuer),
			source: holder,
		}),
	)
	if (o.extraOp)
		b.addOperation(
			Operation.payment({
				destination: sponsor,
				asset: Asset.native(),
				amount: "1",
				source: holder,
			}),
		)
	b.addOperation(Operation.endSponsoringFutureReserves({ source: holder }))
	const tx = b.setTimeout(180).build()
	if (o.signSponsor ?? true) tx.sign(cfg.signer)
	if (o.signHolder ?? true) tx.sign(o.holder)
	return tx.toXDR()
}

describe("validateSep7Callback — Case B sponsored sandwich", () => {
	const holder = Keypair.random()

	it("accepts the sponsor-sourced sandwich once the holder signed it", () => {
		expect(validateSep7Callback(cfg, sponsoredXdr({ holder }))).toEqual({
			asset: EURCV,
			holder: holder.publicKey(),
			countersign: true,
			kind: "sponsored",
		})
		expect(
			validateSep7Callback(cfg, sponsoredXdr({ holder, createAccount: true })),
		).toMatchObject({ kind: "sponsored", holder: holder.publicKey() })
	})

	const refuses = (name: string, xdrB64: string, re: RegExp) =>
		it(`refuses ${name}`, () => {
			const r = validateSep7Callback(cfg, xdrB64)
			expect(r).toMatchObject({ status: 400 })
			expect(
				String((r as unknown as { body: { detail: string } }).body.detail),
			).toMatch(re)
		})
	refuses(
		"a sandwich without the holder's signature",
		sponsoredXdr({ holder, signHolder: false }),
		/no signature from the holder/,
	)
	refuses(
		"a sandwich sponsored by someone else",
		sponsoredXdr({ holder, sponsor: Keypair.random().publicKey() }),
		/sourced by the relayer/,
	)
	refuses(
		"an unpinned asset",
		sponsoredXdr({
			holder,
			asset: { code: "FAKE", issuer: Keypair.random().publicKey() },
		}),
		/not pinned/,
	)
	refuses(
		"a smuggled operation inside the sponsorship window",
		sponsoredXdr({ holder, extraOp: true }),
		/unsafe to sponsor/,
	)
})

describe("POST /v1/sep7/callback — Case B chains the authorization", () => {
	const on: RelayerConfig = { ...cfg, allowSep7Callback: true }
	it("submits the sandwich, then authorizes a regulated asset — one user signature", async () => {
		const holder = Keypair.random()
		const calls: string[] = []
		const r = await handleRequest(
			on,
			ops({
				view: async () => view(gStatus()),
				submitSep7: async (_x, c) => {
					calls.push(`submit:${c}`)
					return "aaaa"
				},
				authorize: async () => {
					calls.push("authorize")
					return "bbbb"
				},
			}),
			"POST",
			new URL("http://x/v1/sep7/callback"),
			undefined,
			{
				contentType: "application/x-www-form-urlencoded",
				text: `xdr=${encodeURIComponent(sponsoredXdr({ holder }))}`,
			},
		)
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({ txHash: "aaaa", authorizeTxHash: "bbbb" })
		expect(calls).toEqual(["submit:true", "authorize"])
	})

	it("does not authorize an open asset", async () => {
		const holder = Keypair.random()
		const r = await handleRequest(
			on,
			ops({
				view: async () => view(gStatus()),
				submitSep7: async () => "aaaa",
			}),
			"POST",
			new URL("http://x/v1/sep7/callback"),
			undefined,
			{
				contentType: "application/x-www-form-urlencoded",
				text: `xdr=${encodeURIComponent(
					sponsoredXdr({
						holder,
						asset: { code: USDC!.code, issuer: USDC!.issuer },
					}),
				)}`,
			},
		)
		expect(r.body).toMatchObject({ txHash: "aaaa", asset: "USDC" })
		expect(r.body.authorizeTxHash).toBeUndefined()
	})
})

describe("POST /v1/sep7/request — cases A and B", () => {
	const request = (body: unknown, o: Partial<ChainOps>) =>
		handleRequest(
			cfg,
			ops(o),
			"POST",
			new URL("http://x/v1/sep7/request"),
			undefined,
			{
				contentType: "application/json",
				text: JSON.stringify(body),
			},
		)

	it("Case A: authorizes on the holder's behalf right away — no request, zero signatures", async () => {
		const r = await request(
			{ account: HOLDER, asset: "EURCV" },
			{
				view: async () => view(gStatus({ hasTrustline: true })),
				authorize: async () => "cafe",
			},
		)
		expect(r.body).toMatchObject({
			case: "A",
			authorized: true,
			txHash: "cafe",
		})
		expect(r.body.sep7Uri).toBeUndefined()
	})

	it("Case B: hands out the sponsor-signed sandwich for an account with nothing", async () => {
		let built: [string, boolean] | undefined
		const holder = Keypair.random()
		const r = await request(
			{ account: holder.publicKey(), asset: "EURCV" },
			{
				view: async () => view(gStatus(), false),
				buildSponsoredOnboard: async (_a, h, create) => {
					built = [h, create]
					return sponsoredXdr({
						holder,
						createAccount: true,
						signHolder: false,
					})
				},
			},
		)
		expect(r.status).toBe(200)
		expect(r.body).toMatchObject({
			case: "B",
			sponsored: true,
			createAccount: true,
		})
		expect(built).toEqual([holder.publicKey(), true])
		// The sponsor's signature travels inside the request — that is what
		// lets the wallet's single signature complete it.
		const parsed = parseSep7TxRequest((r.body as { sep7Uri: string }).sep7Uri)
		const tx = TransactionBuilder.fromXDR(parsed.xdr, cfg.networkPassphrase)
		expect(tx.signatures).toHaveLength(1)
	})

	it("Case B (underfunded): existing account below the reserve is sponsored without CreateAccount", async () => {
		const holder = Keypair.random()
		let create: boolean | undefined
		const r = await request(
			{ account: holder.publicKey(), asset: "USDC" },
			{
				view: async () => view(gStatus(), true, "0.9000000"),
				buildSponsoredOnboard: async (_a, _h, c) => {
					create = c
					return sponsoredXdr({
						holder,
						asset: { code: USDC!.code, issuer: USDC!.issuer },
						signHolder: false,
					})
				},
			},
		)
		expect(r.body).toMatchObject({ case: "B", createAccount: false })
		expect(create).toBe(false)
	})
})

describe("POST /v1/claimable/send", () => {
	const send = (body: unknown, o: Partial<ChainOps>, c = cfg) =>
		handleRequest(
			c,
			ops(o),
			"POST",
			new URL("http://x/v1/claimable/send"),
			undefined,
			{
				contentType: "application/json",
				text: JSON.stringify(body),
			},
		)

	it("pays a claimable balance from the treasury and links the claim page", async () => {
		let sent: [string, string, string] | undefined
		const r = await send(
			{ account: HOLDER, asset: "USDC", amount: "25" },
			{
				sendClaimable: async (a, to, amt) => {
					sent = [a.code, to, amt]
					return { balanceId: "00".repeat(36), txHash: "d00d" }
				},
			},
		)
		expect(r.status).toBe(200)
		expect(sent).toEqual(["USDC", HOLDER, "25"])
		expect(r.body).toMatchObject({
			balanceId: "00".repeat(36),
			txHash: "d00d",
			claimUrl: `https://authline.io/app.html?address=${HOLDER}&asset=USDC`,
		})
	})

	it("refuses contracts, bad amounts, and amounts over the cap", async () => {
		expect(
			(await send({ account: SMART, amount: "1" }, {})).body,
		).toMatchObject({
			error: "invalid_account",
		})
		expect((await send({ account: HOLDER, amount: "-1" }, {})).status).toBe(400)
		expect(
			(await send({ account: HOLDER, amount: "1.12345678" }, {})).status,
		).toBe(400)
		expect(
			(await send({ account: HOLDER, amount: "101" }, {})).body,
		).toMatchObject({ error: "amount_too_large" })
		expect(
			(
				await send(
					{ account: HOLDER, amount: "5" },
					{},
					{
						...cfg,
						claimableMaxAmount: 2,
					},
				)
			).body,
		).toMatchObject({ error: "amount_too_large" })
	})
})
