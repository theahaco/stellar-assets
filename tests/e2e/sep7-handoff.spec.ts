import { spawn, type ChildProcess } from "node:child_process"
import { expect, test, type Page } from "@playwright/test"
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk"
import {
	buildOnboardTx,
	onboardingRequest,
	resolveOfficialAsset,
	ROUTERS,
} from "@theahaco/authline"

// The SEP-7 handoff, end to end on testnet, the way a real integrator runs it:
//
//   withdraw.html (exchange screen) ──POST /v1/sep7/request──► relayer (backend)
//        │  shows QR + "Sign with Authline" link                  │ signs the request
//        ▼                                                        │
//   app.html?sep7=web+stellar:tx?…  (the receiving page)          │
//        │  verifies origin_domain, explains the tx, wallet signs │
//        └──POST /v1/sep7/callback (signed xdr)──────────────────►│ submits, returns hash
//
// The wallet is the e2e seam (a Node-side keypair signing exactly what
// Freighter would). The relayer is the real service, started on loopback.

const PASSPHRASE = Networks.TESTNET
const RPC = "https://soroban-testnet.stellar.org"
const RELAYER = "http://127.0.0.1:8787"
const usdc = resolveOfficialAsset("USDC", "TESTNET")!

let relayer: ChildProcess | undefined
test.beforeAll(async () => {
	relayer = spawn("node", ["packages/relayer/dist/server.js"], {
		env: {
			...process.env,
			STELLAR_NETWORK: "TESTNET",
			RELAYER_SECRET: Keypair.random().secret(),
			HOST: "127.0.0.1",
			PORT: "8787",
			DEFAULT_ASSET: "USDC",
			SEP7_PUBLIC_URL: RELAYER,
			// The receiving page of THIS preview server, not authline.io.
			SEP7_HANDLER_BASE: "http://localhost:4173/app.html",
			// No origin domain: a loopback host has no stellar.toml a browser can
			// verify over https, so the request goes out unsigned — the receiver
			// must say so, and still let the user sign.
		},
		stdio: "inherit",
	})
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		try {
			const r = await fetch(`${RELAYER}/healthz`)
			if (r.ok) {
				const h = (await r.json()) as { sep7Callback?: string }
				expect(h.sep7Callback).toBe("/v1/sep7/callback")
				return
			}
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 300))
	}
	throw new Error("relayer did not start")
})
test.afterAll(() => {
	relayer?.kill()
})

async function fundedHolder(): Promise<Keypair> {
	const kp = Keypair.random()
	const r = await fetch(`https://friendbot.stellar.org/?addr=${kp.publicKey()}`)
	if (!r.ok) throw new Error("friendbot failed")
	return kp
}

/** Install the e2e wallet seam: the secret stays in Node. */
async function installWallet(page: Page, holder: Keypair) {
	await page.exposeFunction("__authlineSign", (xdr: string) => {
		const tx = TransactionBuilder.fromXDR(xdr, PASSPHRASE)
		tx.sign(holder)
		return tx.toXDR()
	})
	await page.addInitScript((address) => {
		;(globalThis as unknown as { __AUTHLINE_E2E__: unknown }).__AUTHLINE_E2E__ =
			{
				address,
				async signTransaction(xdr: string) {
					const signedTxXdr = await (
						globalThis as unknown as {
							__authlineSign: (x: string) => Promise<string>
						}
					).__authlineSign(xdr)
					return { signedTxXdr }
				},
			}
	}, holder.publicKey())
}

test("exchange withdrawal → relayer-built SEP-7 → Authline receiver → callback → paid", async ({
	browser,
}) => {
	const holder = await fundedHolder()

	// 1. The exchange screen. It only talks to its backend (the relayer).
	const exchange = await browser.newPage()
	await exchange.goto("/withdraw.html")
	await exchange.getByRole("combobox").selectOption("USDC")
	await exchange.getByPlaceholder("G…").fill(holder.publicKey())
	await exchange.getByRole("button", { name: /Continue to withdrawal/ }).click()
	await expect(exchange.getByText("Approve in your wallet")).toBeVisible({
		timeout: 60_000,
	})
	// All three handoff surfaces are offered.
	await expect(exchange.getByAltText(/SEP-7 request QR/)).toBeVisible()
	const rawLink = await exchange
		.getByRole("link", { name: "Open in wallet" })
		.getAttribute("href")
	expect(rawLink?.startsWith("web+stellar:tx?")).toBe(true)
	const handlerUrl = await exchange
		.getByRole("link", { name: "Sign with Authline" })
		.getAttribute("href")
	expect(handlerUrl?.startsWith("http://localhost:4173/app.html?sep7=")).toBe(
		true,
	)

	// 2. The user's side: the receiving page, with their wallet.
	const walletCtx = await browser.newContext()
	const wallet = await walletCtx.newPage()
	await installWallet(wallet, holder)
	await wallet.goto(handlerUrl!)
	await expect(wallet.getByText("Sign a request")).toBeVisible()
	// The request explains itself before anything is signed.
	await expect(wallet.getByText("Activate USDC", { exact: true })).toBeVisible()
	await expect(wallet.getByText("Unsigned")).toBeVisible() // no origin_domain
	await expect(wallet.getByText("Returned to the sender")).toBeVisible()
	await expect(
		wallet.getByText(/Northwind Exchange: activate USDC/),
	).toBeVisible()
	await wallet.getByRole("button", { name: /Connect wallet to sign/ }).click()
	await wallet.getByRole("button", { name: /Sign · 1 signature/ }).click()

	// 3. The wallet posted the signed envelope to the relayer, which submitted.
	await expect(wallet.getByText(/USDC trustline authorized/)).toBeVisible({
		timeout: 180_000,
	})
	await expect(wallet.getByText(/Your signature went back to/)).toBeVisible()
	await expect(
		wallet.getByRole("link", { name: /View on Explorer/ }),
	).toHaveAttribute(
		"href",
		/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}/,
	)

	// 4. The exchange saw the ledger change and can pay the withdrawal.
	await expect(
		exchange.getByText("Activated — withdrawal can be paid"),
	).toBeVisible({ timeout: 120_000 })
	await expect(
		exchange.getByRole("link", { name: /^Transaction / }),
	).toHaveAttribute(
		"href",
		/stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}/,
	)

	await walletCtx.close()
	await exchange.close()
})

test("receiver without a callback: the page submits and reports the hash", async ({
	page,
}) => {
	// A request built directly with the SDK (no relayer, no callback): the
	// receiving page submits to the network itself.
	const holder = await fundedHolder()
	const xdr = await buildOnboardTx({
		rpcUrl: RPC,
		networkPassphrase: PASSPHRASE,
		holder: holder.publicKey(),
		config: {
			assetCode: usdc.code,
			assetIssuer: usdc.issuer,
			sac: usdc.sac,
			router: ROUTERS.TESTNET,
			backends: ["cap73-one-signature"],
		},
	})
	const req = onboardingRequest({
		txXdr: xdr,
		networkPassphrase: PASSPHRASE,
		userAddress: holder.publicKey(),
		msg: "Direct SDK request",
		hostedBase: "http://localhost:4173/app.html",
	})
	await installWallet(page, holder)
	await page.goto(req.handlerUrl!)
	await expect(page.getByText("Submitted to the network")).toBeVisible()
	await page.getByRole("button", { name: /Connect wallet to sign/ }).click()
	await page.getByRole("button", { name: /Sign · 1 signature/ }).click()
	await expect(page.getByText(/USDC trustline authorized/)).toBeVisible({
		timeout: 180_000,
	})
})

test("a request for another network or a broken link is refused before signing", async ({
	page,
}) => {
	await page.goto(
		"/app.html?sep7=" +
			encodeURIComponent(
				"web+stellar:tx?xdr=AAAA&network_passphrase=" +
					encodeURIComponent(Networks.PUBLIC),
			),
	)
	await expect(page.getByText(/not a signable SEP-7 request/)).toBeVisible()
	await expect(page.getByText(/another network/)).toBeVisible()
	await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0)
})
