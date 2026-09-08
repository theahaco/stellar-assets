import {
	Address,
	Keypair,
	StrKey,
	TransactionBuilder,
	scValToNative,
	xdr,
	type FeeBumpTransaction,
	type Transaction,
} from "@stellar/stellar-sdk"

/**
 * The WALLET side of the SEP-7 handoff.
 *
 * `onboardingRequest()` (exchange.ts) is what an integrator calls to EMIT a
 * `web+stellar:tx` request. This module is what the page that RECEIVES one
 * needs: parse it, verify who sent it, explain what it does in words a person
 * can check before signing, and — when the request names a `callback` — hand
 * the signed envelope back to the integrator instead of submitting.
 *
 * Nothing here signs. Signing stays with the user's wallet.
 */

/** SEP-7 caps `msg` at 300 characters before URL-encoding. */
export const SEP7_MSG_MAX = 300

/** A parsed SEP-7 `tx` request. Only the parameters the spec defines. */
export interface Sep7TxRequest {
	op: "tx"
	/** Base64 transaction envelope — the thing the wallet signs. */
	xdr: string
	/** Network the request is for; absent means the wallet's default (pubnet). */
	networkPassphrase?: string
	/** Where to POST the signed envelope instead of submitting (`url:` stripped). */
	callback?: string
	/** The key the requester expects to sign, if it said. */
	pubkey?: string
	/** Human message from the requester. Untrusted text. */
	msg?: string
	/** Domain whose stellar.toml `URI_REQUEST_SIGNING_KEY` signed this request. */
	originDomain?: string
	/** Base64 signature over the request, if present. */
	signature?: string
	/** The request URI exactly as received. */
	uri: string
}

/**
 * The SEP-7 signing payload: 35 zero bytes, a `4` byte (envelope type), then
 * `stellar.sep.7 - URI Scheme` concatenated directly onto the request WITHOUT
 * its `signature` parameter.
 */
export function sep7SigningPayload(uriWithoutSignature: string): Buffer {
	const prefix = Buffer.alloc(36)
	prefix[35] = 4
	return Buffer.concat([
		prefix,
		Buffer.from(`stellar.sep.7 - URI Scheme${uriWithoutSignature}`, "utf8"),
	])
}

/** Strip the trailing `&signature=…` (it must be last, per the spec). */
function withoutSignature(uri: string): string {
	return uri.replace(/&signature=[^&]*$/, "")
}

const DOMAIN_RE =
	/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

/**
 * Parse a `web+stellar:tx?…` request. Throws with a reason a UI can show for
 * anything that is not a well-formed `tx` request; the envelope must decode
 * for `networkPassphrase` when one is given (yours, the wallet's), so a
 * mainnet request never reaches a testnet signer half-parsed.
 */
export function parseSep7TxRequest(
	uri: string,
	opts: { networkPassphrase?: string } = {},
): Sep7TxRequest {
	const trimmed = uri.trim()
	// `web+stellar:tx?…` — also tolerate the `web+stellar://tx?…` form some
	// link generators emit; the spec form has no slashes.
	const m = /^web\+stellar:(?:\/\/)?([a-z]+)\?(.*)$/i.exec(trimmed)
	if (!m) throw new Error("not a web+stellar: request")
	const op = m[1].toLowerCase()
	if (op !== "tx")
		throw new Error(
			op === "pay"
				? "this is a SEP-7 `pay` request — only `tx` requests carry a transaction to sign"
				: `unsupported SEP-7 operation '${op}'`,
		)
	const params = new URLSearchParams(m[2])
	const txXdr = params.get("xdr")
	if (!txXdr) throw new Error("the request has no `xdr` parameter")

	const networkPassphrase = params.get("network_passphrase") ?? undefined
	const want = opts.networkPassphrase
	if (want && networkPassphrase && networkPassphrase !== want)
		throw new Error(
			`this request is for another network ("${networkPassphrase}")`,
		)
	try {
		TransactionBuilder.fromXDR(txXdr, want ?? networkPassphrase ?? "")
	} catch (e) {
		throw new Error(
			`the request's xdr is not a transaction envelope: ${
				e instanceof Error ? e.message : String(e)
			}`,
		)
	}

	const out: Sep7TxRequest = { op: "tx", xdr: txXdr, uri: trimmed }
	if (networkPassphrase) out.networkPassphrase = networkPassphrase

	const callback = params.get("callback")
	if (callback) {
		if (!callback.startsWith("url:"))
			throw new Error("SEP-7 `callback` must be a `url:` value")
		const target = callback.slice(4)
		let parsedUrl: URL
		try {
			parsedUrl = new URL(target)
		} catch {
			throw new Error("SEP-7 `callback` is not a valid URL")
		}
		if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:")
			throw new Error("SEP-7 `callback` must be an http(s) URL")
		out.callback = target
	}

	const pubkey = params.get("pubkey")
	if (pubkey) {
		if (!StrKey.isValidEd25519PublicKey(pubkey))
			throw new Error("SEP-7 `pubkey` is not a Stellar public key")
		out.pubkey = pubkey
	}

	const msg = params.get("msg")
	if (msg) {
		if (msg.length > SEP7_MSG_MAX)
			throw new Error(`SEP-7 \`msg\` exceeds ${SEP7_MSG_MAX} characters`)
		out.msg = msg
	}

	const originDomain = params.get("origin_domain")
	if (originDomain) {
		if (!DOMAIN_RE.test(originDomain))
			throw new Error("SEP-7 `origin_domain` must be a bare domain name")
		out.originDomain = originDomain.toLowerCase()
	}

	const signature = params.get("signature")
	if (signature) {
		if (!originDomain)
			throw new Error(
				"the request is signed but names no `origin_domain` to verify against",
			)
		out.signature = signature
	}
	return out
}

/**
 * Verify a request's `signature` against the requester's published
 * `URI_REQUEST_SIGNING_KEY` (a G… public key). False for a missing, malformed
 * or mismatching signature — never throws on bad input, so a UI can render
 * "unverified" without a try/catch.
 */
export function verifySep7Signature(uri: string, signingKey: string): boolean {
	const m = /&signature=([^&]*)$/.exec(uri.trim())
	if (!m) return false
	if (!StrKey.isValidEd25519PublicKey(signingKey)) return false
	let sig: Buffer
	try {
		sig = Buffer.from(decodeURIComponent(m[1]), "base64")
	} catch {
		return false
	}
	if (sig.length !== 64) return false
	try {
		return Keypair.fromPublicKey(signingKey).verify(
			sep7SigningPayload(withoutSignature(uri.trim())),
			sig,
		)
	} catch {
		return false
	}
}

/**
 * Read `URI_REQUEST_SIGNING_KEY` from a domain's `stellar.toml`. Returns null
 * when the toml has none. Throws on network failure — in a browser that
 * includes a missing CORS header on the toml, which a UI should report as
 * "could not verify", not "forged".
 */
export async function fetchSep7SigningKey(
	originDomain: string,
	fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
	if (!DOMAIN_RE.test(originDomain))
		throw new Error(`not a domain name: ${originDomain}`)
	const res = await fetchImpl(
		`https://${originDomain}/.well-known/stellar.toml`,
		{ redirect: "follow" },
	)
	if (!res.ok)
		throw new Error(`stellar.toml for ${originDomain}: HTTP ${res.status}`)
	return signingKeyFromToml(await res.text())
}

/** Pull `URI_REQUEST_SIGNING_KEY` out of a stellar.toml body. */
export function signingKeyFromToml(toml: string): string | null {
	const m = /^\s*URI_REQUEST_SIGNING_KEY\s*=\s*"?(G[A-Z2-7]{55})"?\s*$/m.exec(
		toml,
	)
	return m && StrKey.isValidEd25519PublicKey(m[1]) ? m[1] : null
}

/** One operation of a SEP-7 transaction, in words. */
export interface Sep7OpSummary {
	/** Stellar operation type (`invokeHostFunction`, `changeTrust`, …). */
	type: string
	/** Op-level source, when it differs from the transaction's. */
	source?: string
	/** Soroban: the invoked contract id. */
	contract?: string
	/** Soroban: the invoked function name. */
	function?: string
	/** Soroban: decoded arguments (Addresses as strings, ints as bigint…). */
	args?: unknown[]
	/** Soroban: addresses whose authorization entries this op carries. */
	authorizers?: string[]
	/** Classic: a one-line description of what the op does. */
	detail?: string
	/** Classic `changeTrust`: the asset being trusted. */
	asset?: { code: string; issuer: string }
	/** Classic `beginSponsoringFutureReserves`: the account being sponsored. */
	sponsored?: string
}

/** What a SEP-7 transaction asks for — what a wallet should show. */
export interface Sep7TxSummary {
	/** Transaction (or fee-bump fee) source — pays the fee and sequence. */
	source: string
	/** Fee in stroops. */
	fee: string
	feeBump: boolean
	/** Number of signatures the envelope already carries. */
	signatures: number
	ops: Sep7OpSummary[]
	/**
	 * Accounts whose signature the envelope needs: the source, per-op sources,
	 * and every smart-account auth entry. A wallet compares this against the
	 * account it controls.
	 */
	signers: string[]
	/**
	 * Present when the transaction is a single Authline router `onboard(sac,
	 * holder)` — the shape `buildOnboardTx` emits. Lets a UI say "activate
	 * <asset> for <holder>" instead of dumping a contract call.
	 */
	onboard?: { router: string; sac: string; holder: string }
}

const scAddr = (a: xdr.ScAddress): string => Address.fromScAddress(a).toString()

function summarizeOp(op: Transaction["operations"][number]): Sep7OpSummary {
	const out: Sep7OpSummary = { type: op.type }
	if (op.source) out.source = op.source
	if (op.type === "invokeHostFunction") {
		const fn = op.func
		if (fn.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
			const inv = fn.invokeContract()
			out.contract = scAddr(inv.contractAddress())
			out.function = inv.functionName().toString()
			out.args = inv.args().map((a) => {
				try {
					return scValToNative(a)
				} catch {
					return a.toXDR("base64")
				}
			})
		} else {
			out.function = fn.switch().name
		}
		out.authorizers = (op.auth ?? [])
			.filter(
				(e) =>
					e.credentials().switch() ===
					xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
			)
			.map((e) => scAddr(e.credentials().address().address()))
	} else if (op.type === "changeTrust") {
		const asset = op.line
		if ("code" in asset) out.asset = { code: asset.code, issuer: asset.issuer }
		out.detail =
			"code" in asset
				? `trust ${asset.code}:${asset.issuer}${op.limit ? ` up to ${op.limit}` : ""}`
				: "trust a liquidity pool"
	} else if (op.type === "payment") {
		out.detail = `pay ${op.amount} ${op.asset.code} to ${op.destination}`
	} else if (op.type === "createAccount") {
		out.detail = `create ${op.destination} with ${op.startingBalance} XLM`
	} else if (op.type === "beginSponsoringFutureReserves") {
		out.sponsored = op.sponsoredId
		out.detail = `sponsor reserves for ${op.sponsoredId}`
	} else if (op.type === "claimClaimableBalance") {
		out.detail = `claim balance ${op.balanceId}`
	}
	return out
}

/**
 * Explain a SEP-7 transaction envelope. Pure XDR work — no network. Throws
 * only when the envelope does not decode for `networkPassphrase`.
 */
export function describeSep7Tx(
	txXdr: string,
	networkPassphrase: string,
): Sep7TxSummary {
	const env = TransactionBuilder.fromXDR(txXdr, networkPassphrase)
	const feeBump = "innerTransaction" in env
	const inner: Transaction = feeBump
		? (env as FeeBumpTransaction).innerTransaction
		: (env as Transaction)
	const ops = inner.operations.map(summarizeOp)
	const signers = new Set<string>()
	if (feeBump) signers.add((env as FeeBumpTransaction).feeSource)
	signers.add(inner.source)
	for (const o of ops) {
		if (o.source) signers.add(o.source)
		for (const a of o.authorizers ?? []) signers.add(a)
	}
	const out: Sep7TxSummary = {
		source: feeBump ? (env as FeeBumpTransaction).feeSource : inner.source,
		fee: env.fee,
		feeBump,
		signatures: feeBump
			? env.signatures.length +
				(env as FeeBumpTransaction).innerTransaction.signatures.length
			: env.signatures.length,
		ops,
		signers: [...signers],
	}
	const only = ops.length === 1 ? ops[0] : undefined
	if (
		only &&
		only.type === "invokeHostFunction" &&
		only.function === "onboard" &&
		only.contract &&
		only.args?.length === 2 &&
		typeof only.args[0] === "string" &&
		typeof only.args[1] === "string" &&
		StrKey.isValidContract(only.args[0]) &&
		(StrKey.isValidEd25519PublicKey(only.args[1]) ||
			StrKey.isValidContract(only.args[1]))
	) {
		out.onboard = {
			router: only.contract,
			sac: only.args[0],
			holder: only.args[1],
		}
	}
	return out
}

/**
 * The account a SEP-7 `tx` request wants to sign: the `pubkey` it names; else
 * the onboarded holder (router call); else the SPONSORED account of a CAP-33
 * sandwich — the sponsor sources that envelope, and has usually signed it
 * already, so the source is precisely who must NOT sign again; else the one
 * per-operation source that differs from the transaction's; else the source.
 */
export function sep7Signer(req: Sep7TxRequest, summary: Sep7TxSummary): string {
	if (req.pubkey) return req.pubkey
	if (summary.onboard) return summary.onboard.holder
	const sponsored = summary.ops.find((o) => o.sponsored)?.sponsored
	if (sponsored) return sponsored
	const opSources = [
		...new Set(
			summary.ops
				.map((o) => o.source)
				.filter((s): s is string => !!s && s !== summary.source),
		),
	]
	if (opSources.length === 1) return opSources[0]
	return summary.source
}

/**
 * Deliver a signed envelope to the request's `callback`, the way SEP-7 says:
 * a form-encoded POST with a single `xdr` field. Returns the parsed JSON body
 * when the callback answers with one (the Authline relayer returns
 * `{ txHash }`), else the raw text.
 */
export async function postSep7Callback(
	callbackUrl: string,
	signedXdr: string,
	fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; body: unknown }> {
	const res = await fetchImpl(callbackUrl, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ xdr: signedXdr }).toString(),
	})
	const text = await res.text()
	let body: unknown = text
	try {
		body = JSON.parse(text)
	} catch {
		/* not JSON */
	}
	if (!res.ok) {
		const detail =
			body && typeof body === "object" && "detail" in body
				? String((body as { detail: unknown }).detail)
				: text.slice(0, 200)
		throw new Error(
			`callback refused the signed transaction (${res.status}): ${detail}`,
		)
	}
	return { status: res.status, body }
}

/**
 * URL of a hosted page that receives SEP-7 requests — the Authline activation
 * page does (`app.html?sep7=…`). Useful as an "Open in browser" fallback for
 * users whose wallet registered no `web+stellar:` handler.
 */
export function sep7HandlerUrl(handlerBase: string, sep7Uri: string): string {
	const base = handlerBase.replace(/[?#].*$/, "")
	return `${base}?sep7=${encodeURIComponent(sep7Uri)}`
}
