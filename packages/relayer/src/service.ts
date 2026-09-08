import { createHash, timingSafeEqual } from "node:crypto"
import {
	StrKey,
	TransactionBuilder,
	type Operation,
	type Transaction,
} from "@stellar/stellar-sdk"
import {
	ROUTERS,
	SEP7_MSG_MAX,
	assertSafeToSponsor,
	assetsForNetwork,
	describeSep7Tx,
	onboardingRequest,
	resolveOfficialAsset,
	type ActivationStatus,
	type OfficialAsset,
} from "@theahaco/authline"
import { type RelayerConfig } from "./config.js"

/** Ledger view of one holder: activation state plus bare account existence. */
export interface AccountView {
	status: ActivationStatus
	/**
	 * Whether the G-account exists on-ledger at all — a missing trustline and a
	 * missing account read identically from the trustline entry, and an
	 * exchange handles them differently (fund vs. onboard). Always `true` for
	 * contract holders (existence is not modeled for them).
	 */
	accountExists: boolean
	/**
	 * Native balance in XLM (decimal string) for a G-account, when read. Drives
	 * the Case B / Case C choice: CAP-73 has no sponsorship, so a holder must
	 * afford its own trustline reserve to take the one-transaction path.
	 */
	xlmBalance?: string
}

/**
 * The chain, abstracted so the HTTP layer is testable without RPC.
 * `server.ts` supplies the real implementation; unit tests supply fakes.
 */
export interface ChainOps {
	view(asset: OfficialAsset, account: string): Promise<AccountView>
	/**
	 * Simulate the authorizer's `is_eligible(account)` — would
	 * `authorize_trustline` be permitted by the policy right now?
	 */
	isEligible(asset: OfficialAsset, account: string): Promise<boolean>
	/** Submit `authorize_trustline(account)` signed by the relayer. Tx hash. */
	authorize(asset: OfficialAsset, account: string): Promise<string>
	/**
	 * Build the unsigned router `onboard(sac, holder)` transaction the SEP-7
	 * request carries: holder-sourced for a G-account, relayer-sourced (fee
	 * source) for a contract holder. Base64 XDR, simulated and assembled.
	 */
	buildOnboard(asset: OfficialAsset, holder: string): Promise<string>
	/**
	 * Submit an already-validated (`validateSep7Callback`) envelope, adding
	 * the relayer's envelope signature first when `countersign`. Tx hash.
	 */
	submitSep7(xdr: string, countersign: boolean): Promise<string>
	/**
	 * Case B: build the CAP-33 sponsored `ChangeTrust` (plus a sponsored
	 * `CreateAccount` when the holder has no account), sourced by the relayer
	 * as sponsor and ALREADY SIGNED by it — the holder's signature completes
	 * it. Base64 XDR.
	 */
	buildSponsoredOnboard(
		asset: OfficialAsset,
		holder: string,
		createAccount: boolean,
	): Promise<string>
	/**
	 * Claimable-balance delivery: send `amount` of `asset` from the relayer's
	 * own treasury to `recipient` as a claimable balance (30-day reclaim).
	 */
	sendClaimable(
		asset: OfficialAsset,
		recipient: string,
		amount: string,
	): Promise<{ balanceId: string; txHash: string }>
}

export interface HttpResult {
	status: number
	body: Record<string, unknown>
	/** Non-JSON answers (the stellar.toml). `body` is ignored when set. */
	text?: { contentType: string; content: string }
}

/** Why an account is not ready, in words an integrator can switch on. */
export type NotReadyReason =
	| "no_account"
	| "no_trustline"
	| "trustline_unauthorized"
	| "not_authorized"

/** Typed authorizer refusals, keyed by `Error(Contract, #n)` code. */
const CONTRACT_REFUSALS: Record<
	number,
	{ status: number; error: string; detail: string }
> = {
	1: {
		status: 403,
		error: "account_banned",
		detail: "the account is on the issuer's denylist",
	},
	2: {
		status: 403,
		error: "account_not_allowed",
		detail:
			"allowlist policy: the issuer has not admitted this account (KYC pending?)",
	},
	3: {
		status: 409,
		error: "no_trustline",
		detail:
			"the account has no trustline for this asset yet — create one first " +
			"(the Authline onboard router does both in one transaction)",
	},
	4: {
		status: 503,
		error: "authorizer_paused",
		detail: "the issuer has paused the authorizer — retry later",
	},
}

const json = (status: number, body: Record<string, unknown>): HttpResult => ({
	status,
	body,
})

/**
 * Constant-time bearer-token check. Comparing sha256 digests (fixed length)
 * lets `timingSafeEqual` run regardless of token lengths, so neither the
 * length nor a prefix of the token leaks through response timing.
 */
const digest = (s: string) => createHash("sha256").update(s).digest()
const tokenMatches = (given: string | undefined, want: string): boolean =>
	given !== undefined && timingSafeEqual(digest(given), digest(want))

const err = (status: number, error: string, detail: string): HttpResult =>
	json(status, { error, detail })

/** Map a chain failure to an HTTP refusal, or a 502 for anything untyped. */
export function explainChainError(e: unknown): HttpResult {
	const text = e instanceof Error ? e.message : String(e)
	const m = /Error\(Contract, #(\d+)\)/.exec(text)
	if (m) {
		const known = CONTRACT_REFUSALS[Number(m[1])]
		if (known) return err(known.status, known.error, known.detail)
		return err(502, "contract_error", `authorizer refused: ${text}`)
	}
	return err(502, "chain_error", text)
}

/**
 * "Ready" means: a payment of this asset to this account will succeed right
 * now. For a contract holder (e.g. a passkey smart account) the SAC's
 * `authorized()` view is the only signal; for a G-account it is the classic
 * trustline, plus the AUTHORIZED flag when the asset is regulated.
 */
export function computeReady(
	asset: OfficialAsset,
	view: AccountView,
): { ready: boolean; reason?: NotReadyReason } {
	const s = view.status
	if (s.holderKind === "contract") {
		return s.sacAuthorized === true
			? { ready: true }
			: { ready: false, reason: "not_authorized" }
	}
	if (!view.accountExists) return { ready: false, reason: "no_account" }
	if (!s.hasTrustline) return { ready: false, reason: "no_trustline" }
	if (asset.authorizer && !s.isAuthorized)
		return { ready: false, reason: "trustline_unauthorized" }
	return { ready: true }
}

/**
 * The onboarding case for one holder, per the SEP's §2:
 *   ready — nothing to do
 *   A     — trustline exists, unauthorized: authorize on their behalf, 0 signatures
 *   B     — no account, or not enough XLM for the reserve: sponsored CAP-33, 1 signature
 *   C     — funded account, no trustline: CAP-73 router, 1 signature
 * A contract holder is always C (the relayer is its fee source).
 */
export type OnboardCase = "ready" | "A" | "B" | "C"

/** XLM a holder needs for CAP-73: 2 base reserves + 1 trustline reserve + fee slack. */
export const CASE_C_MIN_XLM = 1.6

export function diagnoseCase(
	asset: OfficialAsset,
	view: AccountView,
): { case: OnboardCase; createAccount: boolean } {
	if (computeReady(asset, view).ready)
		return { case: "ready", createAccount: false }
	const s = view.status
	if (s.holderKind === "contract") return { case: "C", createAccount: false }
	if (!view.accountExists) return { case: "B", createAccount: true }
	if (s.hasTrustline)
		return asset.authorizer
			? { case: "A", createAccount: false }
			: { case: "ready", createAccount: false }
	const xlm = view.xlmBalance === undefined ? NaN : Number(view.xlmBalance)
	if (Number.isFinite(xlm) && xlm < CASE_C_MIN_XLM)
		return { case: "B", createAccount: false }
	return { case: "C", createAccount: false }
}

function resolveAsset(
	cfg: RelayerConfig,
	query: URLSearchParams,
): OfficialAsset | HttpResult {
	const code = query.get("asset") ?? cfg.defaultAsset
	const asset = resolveOfficialAsset(code, cfg.network)
	if (!asset)
		return err(
			404,
			"unknown_asset",
			`'${code}' is not a pinned asset on ${cfg.network}`,
		)
	return asset
}

const isAsset = (x: OfficialAsset | HttpResult): x is OfficialAsset =>
	!("status" in x)

function parseAccount(raw: string): string | HttpResult {
	if (StrKey.isValidEd25519PublicKey(raw) || StrKey.isValidContract(raw))
		return raw
	return err(400, "invalid_account", `'${raw}' is not a Stellar address`)
}

async function handleReady(
	cfg: RelayerConfig,
	ops: ChainOps,
	asset: OfficialAsset,
	account: string,
): Promise<HttpResult> {
	const view = await ops.view(asset, account)
	const { ready, reason } = computeReady(asset, view)
	const regulated = Boolean(asset.authorizer)
	// Only consult policy when authorize could actually be the fix.
	let authorizable: boolean | undefined
	if (!ready && regulated) {
		try {
			authorizable = await ops.isEligible(asset, account)
		} catch {
			authorizable = undefined
		}
	}
	const s = view.status
	return json(200, {
		account,
		asset: asset.code,
		network: asset.network,
		regulated,
		ready,
		...(reason ? { reason } : {}),
		...(authorizable !== undefined ? { authorizable } : {}),
		status: {
			holderKind: s.holderKind,
			accountExists: view.accountExists,
			hasTrustline: s.hasTrustline,
			isAuthorized: s.isAuthorized,
			...(s.sacAuthorized !== undefined
				? { sacAuthorized: s.sacAuthorized }
				: {}),
			...(s.readError ? { readError: s.readError } : {}),
		},
	})
}

/**
 * Concurrent authorizes for the same (network, asset, account) coalesce onto
 * one promise: the idempotency check in {@link handleAuthorize} is
 * check-then-act, so without this a burst of identical requests would each
 * pass the "not ready yet" check and submit — each spending fees.
 * Per-process state, like the limits in `limits.ts`.
 */
const inflightAuthorize = new Map<string, Promise<HttpResult>>()

async function handleAuthorize(
	cfg: RelayerConfig,
	ops: ChainOps,
	asset: OfficialAsset,
	account: string,
): Promise<HttpResult> {
	if (!asset.authorizer)
		return err(
			400,
			"asset_not_regulated",
			`${asset.code} is an open asset — holders need no authorization`,
		)
	// Idempotent: authorizing an already-ready account is a success, not a
	// chain round-trip the relayer pays fees for.
	const before = await ops.view(asset, account)
	if (computeReady(asset, before).ready)
		return json(200, {
			account,
			asset: asset.code,
			authorized: true,
			alreadyAuthorized: true,
		})
	try {
		const txHash = await ops.authorize(asset, account)
		return json(200, {
			account,
			asset: asset.code,
			authorized: true,
			alreadyAuthorized: false,
			txHash,
		})
	} catch (e) {
		return explainChainError(e)
	}
}

/** What the SEP-7 callback receiver agreed to submit. */
export interface Sep7CallbackIntent {
	asset: OfficialAsset
	holder: string
	/** Whether the relayer must add its own envelope signature (fee source / sponsor). */
	countersign: boolean
	/** `onboard`: router CAP-73 call · `sponsored`: CAP-33 ChangeTrust sandwich (Case B). */
	kind: "onboard" | "sponsored"
}

/**
 * The Case B shape: BeginSponsoring(relayer→holder) · [CreateAccount(holder)
 * by relayer] · ChangeTrust(<pinned asset>) by holder · EndSponsoring by
 * holder — sourced by the relayer as sponsor and carrying the holder's
 * signature (the relayer signed at build time; the wallet added the holder's).
 * `assertSafeToSponsor` from the SDK vets the sandwich; this adds the checks
 * an OPEN endpoint needs: pinned asset, holder ≠ relayer, a holder signature
 * present, fee under the cap.
 */
function validateSponsoredCallback(
	cfg: RelayerConfig,
	xdr: string,
	tx: Transaction,
): Sep7CallbackIntent | HttpResult {
	const bad = (detail: string) => err(400, "not_countersignable", detail)
	const relayer = cfg.signer.publicKey()
	if (tx.source !== relayer)
		return bad("a sponsored envelope must be sourced by the relayer (sponsor)")
	const begin = tx.operations[0] as Operation.BeginSponsoringFutureReserves
	const holder = begin.sponsoredId
	if (!holder || holder === relayer)
		return bad("the sponsored account must be the holder, not the relayer")
	const trust = tx.operations.find(
		(o): o is Operation.ChangeTrust => o.type === "changeTrust",
	)
	if (!trust || !("code" in trust.line))
		return bad("the sandwich carries no asset ChangeTrust")
	const line = trust.line
	const asset = assetsForNetwork(cfg.network).find(
		(a) => a.code === line.code && a.issuer === line.issuer,
	)
	if (!asset) return bad("the ChangeTrust asset is not pinned on this network")
	try {
		assertSafeToSponsor({
			txXdr: xdr,
			networkPassphrase: cfg.networkPassphrase,
			sponsor: relayer,
			user: holder,
			config: { assetCode: asset.code, assetIssuer: asset.issuer },
		})
	} catch (e) {
		return bad(e instanceof Error ? e.message : String(e))
	}
	const cap = cfg.sep7MaxFeeStroops ?? 5_000_000
	if (BigInt(tx.fee) > BigInt(cap))
		return bad(`fee ${tx.fee} stroops exceeds the relayer's cap of ${cap}`)
	// The holder's signature must be there. The relayer re-signs on submit, so
	// its own build-time signature need not have survived.
	const holderHint = StrKey.decodeEd25519PublicKey(holder).subarray(-4)
	const holderSigned = tx.signatures.some((sig) =>
		Buffer.from(sig.hint()).equals(holderHint),
	)
	if (!holderSigned)
		return bad("the sponsored envelope carries no signature from the holder")
	return { asset, holder, countersign: true, kind: "sponsored" }
}

/**
 * Decide whether a signed envelope handed to `POST /v1/sep7/callback` is one
 * this relayer will submit. The endpoint is reachable by anyone (the user's
 * wallet calls it, so no bearer token), which makes this check the whole
 * security boundary. It accepts exactly the transactions `POST /v1/sep7/request`
 * emits — one op, invoke ROUTER.onboard(<pinned SAC>, holder) — in two forms:
 *
 * - HOLDER-sourced (a G-account): the wallet's envelope signature completes
 *   it. The relayer submits as-is and spends nothing; the envelope must
 *   already carry a signature.
 * - RELAYER-sourced (fee source for a smart-account holder): every auth entry
 *   must be ADDRESS credentials for `holder` — never source-account
 *   credentials, which would make the relayer's signature the authorization.
 *   holder ≠ relayer · fee ≤ cap. The relayer countersigns, then submits.
 *
 * Anything else — a payment, a different contract, a fee-bump, an extra op —
 * is refused before a signature is made. The only thing an attacker can make
 * this endpoint do is pay the fee to onboard a holder for a pinned asset,
 * which is the service's purpose, bounded by the per-IP limits.
 */
export function validateSep7Callback(
	cfg: RelayerConfig,
	xdr: string,
): Sep7CallbackIntent | HttpResult {
	const bad = (detail: string) => err(400, "not_countersignable", detail)
	let summary
	try {
		summary = describeSep7Tx(xdr, cfg.networkPassphrase)
	} catch (e) {
		return bad(
			`not a transaction envelope for ${cfg.network}: ${
				e instanceof Error ? e.message : String(e)
			}`,
		)
	}
	if (summary.feeBump) return bad("fee-bump envelopes are not accepted")
	if (
		summary.ops.length >= 3 &&
		summary.ops[0].type === "beginSponsoringFutureReserves"
	)
		return validateSponsoredCallback(
			cfg,
			xdr,
			TransactionBuilder.fromXDR(xdr, cfg.networkPassphrase) as Transaction,
		)
	if (summary.ops.length !== 1) return bad("exactly one operation is accepted")
	const op = summary.ops[0]
	const router = ROUTERS[cfg.network]
	if (!summary.onboard || !router || summary.onboard.router !== router)
		return bad(
			`only ${router ?? "the pinned router"}.onboard(sac, holder) is accepted`,
		)
	const { sac, holder } = summary.onboard
	const asset = assetsForNetwork(cfg.network).find((a) => a.sac === sac)
	if (!asset) return bad(`SAC ${sac} is not a pinned asset on ${cfg.network}`)
	const relayer = cfg.signer.publicKey()
	if (holder === relayer) return bad("the holder cannot be the relayer itself")
	if (op.source && op.source !== summary.source)
		return bad("the operation must not name another source")

	if (summary.source === holder) {
		// Holder-sourced: complete once the wallet signed it. Nothing to add.
		if (summary.signatures === 0)
			return bad("the holder-sourced envelope carries no signature yet")
		return { asset, holder, countersign: false, kind: "onboard" }
	}
	if (summary.source !== relayer)
		return bad(
			`the transaction must be sourced by the holder or by the relayer ` +
				`account ${relayer}`,
		)
	const cap = cfg.sep7MaxFeeStroops ?? 5_000_000
	if (BigInt(summary.fee) > BigInt(cap))
		return bad(`fee ${summary.fee} stroops exceeds the relayer's cap of ${cap}`)
	// Every auth entry must be the holder's, and by ADDRESS credentials.
	// describeSep7Tx lists address-credential entries only, so compare the raw
	// count too: a source-account-credential entry would be invisible there and
	// would turn the relayer's envelope signature into the authorization.
	const env = TransactionBuilder.fromXDR(xdr, cfg.networkPassphrase)
	const rawOp = ("innerTransaction" in env ? env.innerTransaction : env)
		.operations[0] as { auth?: unknown[] }
	const rawAuthCount = rawOp.auth?.length ?? 0
	const authorizers = op.authorizers ?? []
	if (
		rawAuthCount !== authorizers.length ||
		authorizers.some((a) => a !== holder)
	)
		return bad(
			"every authorization entry must be the holder's own address " +
				"credentials — none may be source-account credentials",
		)
	return { asset, holder, countersign: true, kind: "onboard" }
}

/** Parse the SEP-7 callback body: form-encoded `xdr=` (the spec) or JSON. */
export function parseSep7CallbackBody(
	contentType: string | undefined,
	body: string,
): string | HttpResult {
	const ct = (contentType ?? "").split(";")[0].trim().toLowerCase()
	let xdr: unknown
	if (ct === "application/json") {
		try {
			xdr = (JSON.parse(body) as { xdr?: unknown }).xdr
		} catch {
			return err(400, "bad_request", "body is not JSON")
		}
	} else {
		xdr = new URLSearchParams(body).get("xdr") ?? undefined
	}
	if (typeof xdr !== "string" || !xdr)
		return err(
			400,
			"bad_request",
			"send the signed envelope as a form-encoded `xdr` field (SEP-7) or JSON {xdr}",
		)
	return xdr
}

async function handleSep7Callback(
	cfg: RelayerConfig,
	ops: ChainOps,
	xdr: string,
): Promise<HttpResult> {
	const intent = validateSep7Callback(cfg, xdr)
	if ("status" in intent) return intent
	const { asset, holder, countersign, kind } = intent
	// Idempotent like /authorize: a holder that is already ready costs no fee.
	const before = await ops.view(asset, holder)
	if (computeReady(asset, before).ready)
		return json(200, {
			account: holder,
			asset: asset.code,
			authorized: true,
			alreadyAuthorized: true,
		})
	try {
		const txHash = await ops.submitSep7(xdr, countersign)
		// Case B on a regulated asset: the sponsored ChangeTrust only CREATES
		// the trustline. Authorization is a Soroban call that cannot share a
		// classic transaction, so the relayer runs it now — its own fee, no
		// further user signature. Still one signature for the user.
		let authorizeTxHash: string | undefined
		if (kind === "sponsored" && asset.authorizer)
			authorizeTxHash = await ops.authorize(asset, holder)
		return json(200, {
			account: holder,
			asset: asset.code,
			authorized: true,
			alreadyAuthorized: false,
			txHash,
			...(authorizeTxHash ? { authorizeTxHash } : {}),
		})
	} catch (e) {
		return explainChainError(e)
	}
}

/** The `stellar.toml` this relayer publishes as a SEP-7 `origin_domain`. */
export function stellarToml(cfg: RelayerConfig): string {
	return [
		`# Authline relayer — SEP-7 request signing key (origin_domain).`,
		`NETWORK_PASSPHRASE="${cfg.networkPassphrase}"`,
		`URI_REQUEST_SIGNING_KEY="${cfg.sep7Signer.publicKey()}"`,
		"",
	].join("\n")
}

/** JSON body of `POST /v1/sep7/request`. */
interface Sep7RequestBody {
	account?: unknown
	asset?: unknown
	msg?: unknown
}

/**
 * Build a SIGNED SEP-7 request for onboarding `account`: the integrator side
 * of the handoff, as an exchange backend would do it. Returns the
 * `web+stellar:` URI plus the hosted receiving-page link, or says the account
 * is already ready. The request's `callback` points back at this relayer, so
 * the wallet returns the signed envelope here and `/v1/sep7/callback` submits.
 */
async function handleSep7Request(
	cfg: RelayerConfig,
	ops: ChainOps,
	body: string,
): Promise<HttpResult> {
	let parsed: Sep7RequestBody
	try {
		parsed = JSON.parse(body || "{}") as Sep7RequestBody
	} catch {
		return err(400, "bad_request", "body must be JSON {account, asset?, msg?}")
	}
	if (typeof parsed.account !== "string")
		return err(400, "invalid_account", "`account` (G… or C…) is required")
	const account = parseAccount(parsed.account)
	if (typeof account !== "string") return account
	if (account === cfg.signer.publicKey())
		return err(400, "invalid_account", "the relayer cannot onboard itself")
	const code =
		typeof parsed.asset === "string" && parsed.asset
			? parsed.asset
			: cfg.defaultAsset
	const asset = resolveOfficialAsset(code, cfg.network)
	if (!asset)
		return err(
			404,
			"unknown_asset",
			`'${code}' is not a pinned asset on ${cfg.network}`,
		)
	if (!ROUTERS[cfg.network])
		return err(503, "no_router", `no onboard router pinned for ${cfg.network}`)
	const msg =
		typeof parsed.msg === "string" && parsed.msg
			? parsed.msg
			: `Activate ${asset.code} for account ${account.slice(0, 4)}…${account.slice(-4)}`
	if (msg.length > SEP7_MSG_MAX)
		return err(400, "bad_request", `msg exceeds ${SEP7_MSG_MAX} characters`)

	const view = await ops.view(asset, account)
	const diag = diagnoseCase(asset, view)
	if (diag.case === "ready")
		return json(200, {
			account,
			asset: asset.code,
			case: "ready",
			alreadyAuthorized: true,
		})

	// Case A — the trustline exists and only lacks the issuer's authorization.
	// Anyone may submit that (the authorizer is the SAC admin), so the relayer
	// does it right here: zero user signatures, no request to hand out.
	if (diag.case === "A") {
		try {
			const txHash = await ops.authorize(asset, account)
			return json(200, {
				account,
				asset: asset.code,
				case: "A",
				alreadyAuthorized: false,
				authorized: true,
				txHash,
			})
		} catch (e) {
			return explainChainError(e)
		}
	}

	let txXdr: string
	try {
		txXdr =
			diag.case === "B"
				? await ops.buildSponsoredOnboard(asset, account, diag.createAccount)
				: await ops.buildOnboard(asset, account)
	} catch (e) {
		return explainChainError(e)
	}
	const req = onboardingRequest({
		txXdr,
		networkPassphrase: cfg.networkPassphrase,
		userAddress: account,
		callback: `${cfg.sep7PublicUrl}/v1/sep7/callback`,
		hostedBase: cfg.sep7HandlerBase,
		msg,
		...(cfg.sep7OriginDomain
			? { originDomain: cfg.sep7OriginDomain, signer: cfg.sep7Signer }
			: {}),
	})
	return json(200, {
		account,
		asset: asset.code,
		case: diag.case,
		sponsored: diag.case === "B",
		createAccount: diag.createAccount,
		alreadyAuthorized: false,
		sep7Uri: req.sep7Uri,
		handlerUrl: req.handlerUrl,
		callback: `${cfg.sep7PublicUrl}/v1/sep7/callback`,
		signed: Boolean(cfg.sep7OriginDomain),
		originDomain: cfg.sep7OriginDomain ?? null,
		// The envelope's own timeout: the wallet must sign within this window.
		expiresAt: new Date(Date.now() + 180_000).toISOString(),
	})
}

/** JSON body of `POST /v1/claimable/send`. */
interface ClaimableSendBody {
	account?: unknown
	asset?: unknown
	amount?: unknown
}

/**
 * Claimable-balance delivery: when the recipient is not ready, the exchange
 * sends the withdrawal as a claimable balance instead of a payment that would
 * bounce, and the user claims it later on the activation page — for an open
 * asset that one claim signature also opens the trustline. The relayer's own
 * treasury is the sender. Open endpoint, bounded by `claimableMaxAmount` per
 * request and the per-IP limits.
 */
async function handleClaimableSend(
	cfg: RelayerConfig,
	ops: ChainOps,
	body: string,
): Promise<HttpResult> {
	let parsed: ClaimableSendBody
	try {
		parsed = JSON.parse(body || "{}") as ClaimableSendBody
	} catch {
		return err(
			400,
			"bad_request",
			"body must be JSON {account, asset?, amount}",
		)
	}
	if (
		typeof parsed.account !== "string" ||
		!StrKey.isValidEd25519PublicKey(parsed.account)
	)
		return err(
			400,
			"invalid_account",
			"`account` must be a G… address — a claimable balance cannot name a contract as claimant",
		)
	const account = parsed.account
	if (account === cfg.signer.publicKey())
		return err(400, "invalid_account", "the relayer cannot pay itself")
	const code =
		typeof parsed.asset === "string" && parsed.asset
			? parsed.asset
			: cfg.defaultAsset
	const asset = resolveOfficialAsset(code, cfg.network)
	if (!asset)
		return err(
			404,
			"unknown_asset",
			`'${code}' is not a pinned asset on ${cfg.network}`,
		)
	const amountRaw =
		typeof parsed.amount === "string"
			? parsed.amount
			: String(parsed.amount ?? "")
	if (!/^\d+(\.\d{1,7})?$/.test(amountRaw) || !(Number(amountRaw) > 0))
		return err(
			400,
			"bad_request",
			"`amount` must be a positive decimal string (≤ 7 decimals)",
		)
	const max = cfg.claimableMaxAmount ?? 100
	if (Number(amountRaw) > max)
		return err(
			400,
			"amount_too_large",
			`amount exceeds this relayer's per-request cap of ${max} ${asset.code}`,
		)
	try {
		const { balanceId, txHash } = await ops.sendClaimable(
			asset,
			account,
			amountRaw,
		)
		return json(200, {
			account,
			asset: asset.code,
			amount: amountRaw,
			balanceId,
			txHash,
			// Where the recipient collects it: the activation page previewing
			// their account for this asset; connecting the wallet routes to claim.
			claimUrl: `${cfg.sep7HandlerBase}?address=${encodeURIComponent(account)}&asset=${encodeURIComponent(asset.code)}`,
		})
	} catch (e) {
		return explainChainError(e)
	}
}

/**
 * Route one request. Pure with respect to HTTP: the caller passes method,
 * URL, the bearer token (if any) and the body (POSTs only); the chain is
 * behind {@link ChainOps}.
 *
 * Routes:
 *   GET  /healthz
 *   GET  /v1/accounts/:account/ready      [?asset=CODE]
 *   POST /v1/accounts/:account/authorize  [?asset=CODE]
 *   GET  /.well-known/stellar.toml         (URI_REQUEST_SIGNING_KEY)
 *   POST /v1/sep7/request                  {account, asset?, msg?}
 *   POST /v1/sep7/callback                 xdr=<signed> (when allowSep7Callback)
 *   POST /v1/claimable/send                {account, asset?, amount}
 */
export async function handleRequest(
	cfg: RelayerConfig,
	ops: ChainOps,
	method: string,
	url: URL,
	bearerToken?: string,
	body?: { contentType?: string; text: string },
): Promise<HttpResult> {
	if (url.pathname === "/healthz")
		return json(200, {
			ok: true,
			network: cfg.network,
			relayer: cfg.signer.publicKey(),
			defaultAsset: cfg.defaultAsset,
			...(cfg.allowSep7Callback ? { sep7Callback: "/v1/sep7/callback" } : {}),
		})

	if (url.pathname === "/.well-known/stellar.toml") {
		if (method !== "GET") return err(405, "method_not_allowed", "use GET")
		return {
			status: 200,
			body: {},
			text: {
				contentType: "text/plain; charset=utf-8",
				content: stellarToml(cfg),
			},
		}
	}

	if (url.pathname === "/v1/sep7/request") {
		if (method !== "POST") return err(405, "method_not_allowed", "use POST")
		return handleSep7Request(cfg, ops, body?.text ?? "")
	}

	if (url.pathname === "/v1/claimable/send") {
		if (method !== "POST") return err(405, "method_not_allowed", "use POST")
		return handleClaimableSend(cfg, ops, body?.text ?? "")
	}

	if (url.pathname === "/v1/sep7/callback") {
		if (!cfg.allowSep7Callback)
			return err(
				404,
				"not_found",
				"the SEP-7 callback receiver is disabled on this instance (ALLOW_SEP7_CALLBACK)",
			)
		if (method !== "POST") return err(405, "method_not_allowed", "use POST")
		const xdr = parseSep7CallbackBody(body?.contentType, body?.text ?? "")
		if (typeof xdr !== "string") return xdr
		return handleSep7Callback(cfg, ops, xdr)
	}

	const m = /^\/v1\/accounts\/([^/]+)\/(ready|authorize)$/.exec(url.pathname)
	if (!m) return err(404, "not_found", "see /healthz for the route list")
	const [, rawAccount, action] = m

	const account = parseAccount(rawAccount)
	if (typeof account !== "string") return account
	const asset = resolveAsset(cfg, url.searchParams)
	if (!isAsset(asset)) return asset

	if (action === "ready") {
		if (method !== "GET") return err(405, "method_not_allowed", "use GET")
		return handleReady(cfg, ops, asset, account)
	}

	// authorize
	if (method !== "POST") return err(405, "method_not_allowed", "use POST")
	if (cfg.apiToken && !tokenMatches(bearerToken, cfg.apiToken))
		return err(401, "unauthorized", "pass Authorization: Bearer <token>")
	const key = `${cfg.network}:${asset.code}:${account}`
	const pending = inflightAuthorize.get(key)
	if (pending) return pending
	const result = handleAuthorize(cfg, ops, asset, account).finally(() =>
		inflightAuthorize.delete(key),
	)
	inflightAuthorize.set(key, result)
	return result
}
