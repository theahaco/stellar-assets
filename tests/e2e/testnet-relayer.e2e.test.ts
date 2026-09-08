import {
	Asset,
	BASE_FEE,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import { resolveOfficialAsset } from "@theahaco/authline"
import {
	makeChainOps,
	startServer,
	type RelayerConfig,
} from "@theahaco/authline-relayer"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * The relayer against real testnet, end to end: the exact HTTP integration an
 * exchange would write, driven with plain `fetch` — no Stellar SDK on the
 * client side of the calls.
 *
 *   fresh holder      → ready:false  reason:no_trustline    authorizable:true
 *   bare ChangeTrust  → ready:false  reason:trustline_unauthorized
 *   POST /authorize   → 200 + txHash (relayer signs, submits, pays the fee)
 *   after             → ready:true; authorize again → alreadyAuthorized:true
 */

const RUN = process.env.RUN_TESTNET_E2E === "1"
const NET = {
	rpcUrl: "https://soroban-testnet.stellar.org",
	passphrase: Networks.TESTNET,
}
const PINNED = resolveOfficialAsset("EURCV", "TESTNET")!

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function friendbot(pub: string) {
	const r = await fetch(`https://friendbot.stellar.org/?addr=${pub}`)
	if (!r.ok) throw new Error(`friendbot failed for ${pub}`)
}

describe.skipIf(!RUN)(
	"relayer HTTP service against testnet (real chain)",
	() => {
		// The relayer's fee-paying account and the user being onboarded are both
		// throwaway friendbot accounts: authorize_trustline is permissionless.
		const relayerKey = Keypair.random()
		const holder = Keypair.random()
		let base: string
		let server: ReturnType<typeof startServer>

		beforeAll(async () => {
			await Promise.all([
				friendbot(relayerKey.publicKey()),
				friendbot(holder.publicKey()),
			])
			const cfg: RelayerConfig = {
				network: "TESTNET",
				networkPassphrase: NET.passphrase,
				rpcUrl: NET.rpcUrl,
				signer: relayerKey,
				port: 0,
				sep7Signer: relayerKey,
				sep7PublicUrl: "http://127.0.0.1:8787",
				sep7HandlerBase: "http://localhost:4173/app.html", // OS-assigned; read back from the listening socket
				defaultAsset: "EURCV",
			}
			server = startServer(cfg, makeChainOps(cfg))
			await new Promise((r) => server.once("listening", r))
			const addr = server.address()
			if (addr === null || typeof addr === "string")
				throw new Error("no listening port")
			base = `http://127.0.0.1:${addr.port}`
		}, 120_000)

		afterAll(() => {
			server?.close()
		})

		const ready = async () => {
			const r = await fetch(`${base}/v1/accounts/${holder.publicKey()}/ready`)
			expect(r.status).toBe(200)
			return (await r.json()) as Record<string, unknown>
		}

		it("healthz names the relayer account", async () => {
			const r = await fetch(`${base}/healthz`)
			expect(r.status).toBe(200)
			expect(await r.json()).toMatchObject({
				ok: true,
				network: "TESTNET",
				relayer: relayerKey.publicKey(),
			})
		}, 60_000)

		it("a fresh funded account: not ready, no trustline, but authorizable", async () => {
			expect(await ready()).toMatchObject({
				ready: false,
				reason: "no_trustline",
				regulated: true,
				authorizable: true,
				status: { accountExists: true, hasTrustline: false },
			})
		}, 60_000)

		it("an unknown account reads as no_account", async () => {
			const ghost = Keypair.random().publicKey()
			const r = await fetch(`${base}/v1/accounts/${ghost}/ready`)
			expect(await r.json()).toMatchObject({
				ready: false,
				reason: "no_account",
			})
		}, 60_000)

		it("a bare ChangeTrust leaves the trustline unauthorized", async () => {
			const s = new rpc.Server(NET.rpcUrl)
			const acc = await s.getAccount(holder.publicKey())
			const tx = new TransactionBuilder(acc, {
				fee: BASE_FEE,
				networkPassphrase: NET.passphrase,
			})
				.addOperation(
					Operation.changeTrust({
						asset: new Asset(PINNED.code, PINNED.issuer),
					}),
				)
				.setTimeout(120)
				.build()
			tx.sign(holder)
			const sent = await s.sendTransaction(tx)
			expect(sent.status).not.toBe("ERROR")
			let got = await s.getTransaction(sent.hash)
			const deadline = Date.now() + 60_000
			while (got.status === "NOT_FOUND" && Date.now() < deadline) {
				await sleep(1500)
				got = await s.getTransaction(sent.hash)
			}
			expect(got.status).toBe("SUCCESS")

			expect(await ready()).toMatchObject({
				ready: false,
				reason: "trustline_unauthorized",
				authorizable: true,
			})
		}, 120_000)

		it("POST /authorize flips the trustline and returns the tx hash", async () => {
			const r = await fetch(
				`${base}/v1/accounts/${holder.publicKey()}/authorize`,
				{ method: "POST" },
			)
			const body = (await r.json()) as Record<string, unknown>
			expect(r.status).toBe(200)
			expect(body).toMatchObject({ authorized: true, alreadyAuthorized: false })
			expect(String(body.txHash)).toMatch(/^[0-9a-f]{64}$/)

			expect(await ready()).toMatchObject({ ready: true })
		}, 120_000)

		it("authorize is idempotent", async () => {
			const r = await fetch(
				`${base}/v1/accounts/${holder.publicKey()}/authorize`,
				{ method: "POST" },
			)
			expect(r.status).toBe(200)
			expect(await r.json()).toMatchObject({
				authorized: true,
				alreadyAuthorized: true,
			})
		}, 120_000)
	},
)
