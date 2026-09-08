/**
 * Give the relayer account a TREASURY on testnet, so it can pay claimable-
 * balance withdrawals (`POST /v1/claimable/send`) the way an exchange pays out
 * of its own float:
 *
 *   1. USDC trustline on the relayer, then USDC from the `e2e-usdc-sender`
 *      keystore identity (Circle's testnet USDC — friendbot cannot mint it).
 *   2. EURCV (the pinned testnet test token, AUTH_REQUIRED): an AUTHORIZED
 *      trustline via the Authline router (one relayer-signed onboard), then
 *      EURCV minted by the `eurcv-issuer` keystore identity.
 *
 * Usage (from the repo root):
 *     node scripts/fund-relayer-treasury.mjs --relayer relayer-ops [--usdc 40] [--eurcv 1000]
 *
 * All secrets come from the local `stellar` CLI keystore and are only used to
 * sign testnet transactions; nothing is printed or stored. Idempotent: existing
 * trustlines are kept, and amounts are only sent when asked.
 */
import { spawnSync } from "node:child_process"
import {
	Asset,
	BASE_FEE,
	Horizon,
	Keypair,
	Networks,
	Operation,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import {
	buildOnboardTx,
	ROUTERS,
	resolveOfficialAsset,
} from "@theahaco/authline"

const PASSPHRASE = Networks.TESTNET
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org")
const RPC_URL = "https://soroban-testnet.stellar.org"

const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`)
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const RELAYER_ALIAS = arg("relayer", "relayer-ops")
const USDC_AMOUNT = arg("usdc", "40")
const EURCV_AMOUNT = arg("eurcv", "1000")

function keyFromKeystore(alias) {
	const r = spawnSync("stellar", ["keys", "secret", alias], {
		encoding: "utf8",
	})
	if (r.status !== 0)
		throw new Error(`stellar keys secret ${alias} failed: ${r.stderr}`)
	return Keypair.fromSecret(r.stdout.trim())
}

const relayer = keyFromKeystore(RELAYER_ALIAS)
const usdcSender = keyFromKeystore("e2e-usdc-sender")
const eurcvIssuer = keyFromKeystore("eurcv-issuer")
const USDC = resolveOfficialAsset("USDC", "TESTNET")
const EURCV = resolveOfficialAsset("EURCV", "TESTNET")
if (eurcvIssuer.publicKey() !== EURCV.issuer)
	throw new Error(
		"keystore eurcv-issuer is not the pinned testnet EURCV issuer",
	)

console.log(`relayer  ${relayer.publicKey()} (${RELAYER_ALIAS})`)

async function classic(signer, ...ops) {
	const acct = await horizon.loadAccount(signer.publicKey())
	const b = new TransactionBuilder(acct, {
		fee: BASE_FEE,
		networkPassphrase: PASSPHRASE,
	})
	for (const op of ops) b.addOperation(op)
	const tx = b.setTimeout(120).build()
	tx.sign(signer)
	const r = await horizon.submitTransaction(tx)
	return r.hash
}

const balances = async (pub) => (await horizon.loadAccount(pub)).balances
const line = (bs, a) =>
	bs.find((b) => b.asset_code === a.code && b.asset_issuer === a.issuer)

// 1. USDC trustline + funding
let bs = await balances(relayer.publicKey())
if (!line(bs, USDC)) {
	const h = await classic(
		relayer,
		Operation.changeTrust({ asset: new Asset(USDC.code, USDC.issuer) }),
	)
	console.log(`USDC trustline created   ${h}`)
} else console.log("USDC trustline present")
if (Number(USDC_AMOUNT) > 0) {
	const h = await classic(
		usdcSender,
		Operation.payment({
			destination: relayer.publicKey(),
			asset: new Asset(USDC.code, USDC.issuer),
			amount: USDC_AMOUNT,
		}),
	)
	console.log(`USDC ${USDC_AMOUNT} sent          ${h}`)
}

// 2. EURCV authorized trustline via the router (trust + authorize, one tx)
bs = await balances(relayer.publicKey())
const eurcvLine = line(bs, EURCV)
if (!eurcvLine || !eurcvLine.is_authorized) {
	const xdrB64 = await buildOnboardTx({
		rpcUrl: RPC_URL,
		networkPassphrase: PASSPHRASE,
		holder: relayer.publicKey(),
		config: {
			assetCode: EURCV.code,
			assetIssuer: EURCV.issuer,
			sac: EURCV.sac,
			authorizer: EURCV.authorizer,
			router: ROUTERS.TESTNET,
			backends: ["cap73-one-signature"],
		},
	})
	const tx = TransactionBuilder.fromXDR(xdrB64, PASSPHRASE)
	tx.sign(relayer)
	const server = new rpc.Server(RPC_URL)
	const sent = await server.sendTransaction(tx)
	if (sent.status === "ERROR")
		throw new Error(`onboard send error: ${sent.errorResult?.toXDR("base64")}`)
	let got = await server.getTransaction(sent.hash)
	while (got.status === "NOT_FOUND") {
		await new Promise((r) => setTimeout(r, 1500))
		got = await server.getTransaction(sent.hash)
	}
	if (got.status !== "SUCCESS") throw new Error(`onboard failed: ${sent.hash}`)
	console.log(`EURCV trustline authorized ${sent.hash}`)
} else console.log("EURCV trustline authorized already")
if (Number(EURCV_AMOUNT) > 0) {
	const h = await classic(
		eurcvIssuer,
		Operation.payment({
			destination: relayer.publicKey(),
			asset: new Asset(EURCV.code, EURCV.issuer),
			amount: EURCV_AMOUNT,
		}),
	)
	console.log(`EURCV ${EURCV_AMOUNT} minted       ${h}`)
}

bs = await balances(relayer.publicKey())
console.log(
	"treasury:",
	bs.map((b) => `${b.asset_code ?? "XLM"} ${b.balance}`).join(" · "),
)
