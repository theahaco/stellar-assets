import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { expect, test, type Browser, type Page } from "@playwright/test"
import {
	Asset,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import { resolveOfficialAsset } from "@theahaco/authline"

// The three onboarding cases of the SEP plus claimable-balance delivery, each
// driven from the INTEGRATOR screen (withdraw.html) against testnet, with the
// real relayer on loopback as the exchange backend and a Node-side signer
// standing in for the user's wallet. Case C is covered by sep7-handoff.spec.ts.
//
// The relayer needs a funded TREASURY (XLM for sponsored reserves, USDC and
// EURCV to pay claimable balances): E2E_RELAYER_SECRET, or the keystore
// identity `relayer-ops` (funded by `npm run fund:treasury`).

const PASSPHRASE = Networks.TESTNET
const RELAYER = "http://127.0.0.1:8787"
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org")
const EURCV = resolveOfficialAsset("EURCV", "TESTNET")!
const TX_LINK = /stellar\.expert\/explorer\/testnet\/tx\/[0-9a-f]{64}/

function relayerSecret(): string | null {
	if (process.env.E2E_RELAYER_SECRET) return process.env.E2E_RELAYER_SECRET
	try {
		return execFileSync("stellar", ["keys", "secret", "relayer-ops"], {
			encoding: "utf8",
		}).trim()
	} catch {
		return null
	}
}
const RELAYER_SECRET = relayerSecret()
test.skip(
	RELAYER_SECRET === null,
	"needs the funded treasury key: set E2E_RELAYER_SECRET or have a local stellar keystore identity `relayer-ops`",
)

let relayer: ChildProcess | undefined
test.beforeAll(async () => {
	relayer = spawn("node", ["packages/relayer/dist/server.js"], {
		env: {
			...process.env,
			STELLAR_NETWORK: "TESTNET",
			RELAYER_SECRET: RELAYER_SECRET!,
			HOST: "127.0.0.1",
			PORT: "8787",
			DEFAULT_ASSET: "USDC",
			SEP7_PUBLIC_URL: RELAYER,
			SEP7_HANDLER_BASE: "http://localhost:4173/app.html",
		},
		stdio: "inherit",
	})
	const deadline = Date.now() + 30_000
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${RELAYER}/healthz`)).ok) return
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

/** The integrator screen, filled in and submitted. */
async function startWithdrawal(
	browser: Browser,
	o: { asset: string; address: string; amount?: string },
): Promise<Page> {
	const page = await browser.newPage()
	await page.goto("/withdraw.html")
	await page.getByRole("combobox").selectOption(o.asset)
	if (o.amount) await page.getByLabel("Amount").fill(o.amount)
	await page.getByPlaceholder("G…").fill(o.address)
	await page.getByRole("button", { name: /Continue to withdrawal/ }).click()
	return page
}

test("Case A — an unauthorized trustline is authorized on the user's behalf: zero signatures", async ({
	browser,
}) => {
	// The user created a EURCV trustline themselves (any wallet can), which
	// leaves it unauthorized: AUTH_REQUIRED.
	const holder = await fundedHolder()
	const acct = await horizon.loadAccount(holder.publicKey())
	const tx = new TransactionBuilder(acct, {
		fee: BASE_FEE,
		networkPassphrase: PASSPHRASE,
	})
		.addOperation(
			Operation.changeTrust({ asset: new Asset(EURCV.code, EURCV.issuer) }),
		)
		.setTimeout(60)
		.build()
	tx.sign(holder)
	await horizon.submitTransaction(tx)

	const exchange = await startWithdrawal(browser, {
		asset: "EURCV",
		address: holder.publicKey(),
	})
	// No wallet, no QR, no signature: the backend did it.
	await expect(
		exchange.getByText("Activated — withdrawal can be paid"),
	).toBeVisible({ timeout: 120_000 })
	await expect(
		exchange.getByText(/only lacked the issuer’s authorization/),
	).toBeVisible()
	await expect(
		exchange.getByRole("link", { name: /^Transaction / }),
	).toHaveAttribute("href", TX_LINK)
	await exchange.close()
})

test("Case B — an address with NO account: sponsored creation + reserve, one signature, regulated asset authorized", async ({
	browser,
}) => {
	const holder = Keypair.random() // never funded: nothing on the ledger
	const exchange = await startWithdrawal(browser, {
		asset: "EURCV",
		address: holder.publicKey(),
	})
	await expect(exchange.getByText("Approve in your wallet")).toBeVisible({
		timeout: 60_000,
	})
	await expect(
		exchange.getByText(/no account on the network yet/),
	).toBeVisible()
	const handlerUrl = await exchange
		.getByRole("link", { name: "Sign with Authline" })
		.getAttribute("href")

	const walletCtx = await browser.newContext()
	const wallet = await walletCtx.newPage()
	await installWallet(wallet, holder)
	await wallet.goto(handlerUrl!)
	await expect(
		wallet.getByText("Activate EURCV (reserve sponsored)", { exact: true }),
	).toBeVisible()
	// The sponsor's signature already travels inside the request.
	await expect(wallet.getByText("Also signed by")).toBeVisible()
	await wallet.getByRole("button", { name: /Connect wallet to sign/ }).click()
	await wallet.getByRole("button", { name: /Sign · 1 signature/ }).click()
	// Callback: relayer countersigns the sandwich, submits, then authorizes.
	await expect(wallet.getByText(/EURCV trustline authorized/)).toBeVisible({
		timeout: 180_000,
	})
	await expect(
		wallet.getByRole("link", { name: /View on Explorer/ }),
	).toHaveAttribute("href", TX_LINK)

	await expect(
		exchange.getByText("Activated — withdrawal can be paid"),
	).toBeVisible({ timeout: 120_000 })
	// The account exists now, sponsored: reserves paid by the relayer.
	const created = await horizon.loadAccount(holder.publicKey())
	expect(created.balances.some((b) => b.asset_type === "native")).toBe(true)
	const line = created.balances.find(
		(b) => "asset_code" in b && b.asset_code === "EURCV",
	) as { is_authorized?: boolean } | undefined
	expect(line?.is_authorized).toBe(true)
	await walletCtx.close()
	await exchange.close()
})

test("withdrawal-then-claim — paid as a claimable balance, claimed with ONE signature that opens the trustline", async ({
	browser,
}) => {
	const holder = await fundedHolder() // XLM, but no USDC trustline
	const exchange = await startWithdrawal(browser, {
		asset: "USDC",
		address: holder.publicKey(),
		amount: "1", // small: every run gives real testnet USDC away for good
	})
	await expect(exchange.getByText("Approve in your wallet")).toBeVisible({
		timeout: 60_000,
	})
	// The user is not around to sign — the exchange pays anyway.
	await exchange
		.getByRole("button", { name: /Send as claimable balance instead/ })
		.click()
	await expect(
		exchange.getByText("Sent — waiting for you to claim"),
	).toBeVisible({ timeout: 120_000 })
	await expect(
		exchange.getByRole("link", { name: "Delivery transaction" }),
	).toHaveAttribute("href", TX_LINK)
	const claimLink = exchange.getByRole("link", { name: "Claim on Authline" })
	await expect(claimLink).toHaveAttribute(
		"href",
		`http://localhost:4173/app.html?address=${holder.publicKey()}&asset=USDC`,
	)
	const claimUrl = await claimLink.getAttribute("href")

	// Later, the user opens the claim link with their wallet.
	const walletCtx = await browser.newContext()
	const wallet = await walletCtx.newPage()
	await installWallet(wallet, holder)
	await wallet.goto(claimUrl!)
	await wallet.getByRole("button", { name: /Connect to activate/ }).click()
	await wallet.getByRole("button", { name: /Freighter/ }).click() // the seam answers
	await wallet
		.getByRole("button", { name: /Claim .*USDC · 1 signature/ })
		.click({ timeout: 60_000 })
	await expect(wallet.getByText(/USDC claimed/)).toBeVisible({
		timeout: 180_000,
	})
	await expect(
		wallet.getByRole("link", { name: /View on Explorer/ }),
	).toHaveAttribute("href", TX_LINK)
	// One transaction did both: the trustline is open and the balance is in.
	const after = await horizon.loadAccount(holder.publicKey())
	const usdc = after.balances.find(
		(b) => "asset_code" in b && b.asset_code === "USDC",
	) as { balance: string } | undefined
	expect(usdc?.balance).toBe("1.0000000")
	await walletCtx.close()
	await exchange.close()
})
