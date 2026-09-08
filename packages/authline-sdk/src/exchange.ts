import {
	Account,
	Address,
	Asset,
	BASE_FEE,
	Contract,
	Operation,
	StrKey,
	TransactionBuilder,
	rpc,
} from "@stellar/stellar-sdk"
import { defaultAllowHttp } from "./onboard.js"
import { SEP7_MSG_MAX, sep7HandlerUrl, sep7SigningPayload } from "./sep7.js"
import { type OnboarderConfig } from "./index.js"

/**
 * Third-party (exchange / broker / wallet) integration surface.
 *
 * The invariant: only the user can sign `ChangeTrust`, so the integrator does
 * everything else — pays the reserve, authorizes on the issuer's behalf, and
 * reduces the user to at most one in-flow signature (zero when they already
 * have an unauthorized trustline).
 */

/**
 * Build the permissionless **authorize-on-behalf** transaction (Soroban).
 * Any funded account (`source`) may submit it — the Authorizer contract is the
 * asset's SAC admin and authorizes the holder unless the policy (denylist /
 * allowlist) says otherwise. No user signature, no manual issuer signature.
 *
 * Returns unsigned base64 XDR for the integrator to sign with `source` and submit.
 */
export async function buildAuthorizeTx(opts: {
	rpcUrl: string
	networkPassphrase: string
	/** The integrator's funded account that submits + signs this tx. */
	source: string
	/** The user whose trustline is being authorized. */
	account: string
	config: OnboarderConfig
	allowHttp?: boolean
}): Promise<string> {
	if (!opts.config.authorizer) {
		throw new Error(
			"config.authorizer is required for authorize-on-behalf (Case A) — " +
				"it is the asset's SAC admin",
		)
	}
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const src = await server.getAccount(opts.source)
	const authorizer = new Contract(opts.config.authorizer)
	const tx = new TransactionBuilder(src, {
		fee: BASE_FEE,
		networkPassphrase: opts.networkPassphrase,
	})
		.addOperation(
			authorizer.call(
				"authorize_trustline",
				new Address(opts.account).toScVal(),
			),
		)
		.setTimeout(180)
		.build()
	const prepared = await server.prepareTransaction(tx)
	return prepared.toXDR()
}

/**
 * Build the **reserve-free** classic onboarding transaction (CAP-33 sponsored
 * `ChangeTrust`). The integrator (`sponsor`) pays the 0.5 XLM trustline reserve;
 * the user signs only the `ChangeTrust`/`END_SPONSORING` ops. Pair with
 * `buildAuthorizeTx` (run by the integrator, no user signature) to authorize.
 *
 * Signers required on the returned XDR: `sponsor` (begin-sponsor) + `user`.
 *
 * SECURITY: `config.assetCode`/`assetIssuer` become the `ChangeTrust` asset the
 * user signs. If `config` came from `discoverOnboarder`, reconcile it against
 * the pinned registry first (pass `network` to `discoverOnboarder`, or call
 * `reconcileWithRegistry`) so a spoofed `stellar.toml` cannot trick the user
 * into trusting a counterfeit issuer for a well-known code.
 */
export async function buildSponsoredOnboardTx(opts: {
	rpcUrl: string
	networkPassphrase: string
	/** The integrator account paying the reserve. */
	sponsor: string
	user: string
	config: OnboarderConfig
	/** Set when the user account does not exist yet (sponsored CreateAccount). */
	createUserAccount?: boolean
	/**
	 * Which account sources the transaction, and therefore supplies the sequence
	 * number.
	 *
	 * - `"sponsor"` (default) — the sponsor sources the transaction, so its
	 *   sequence is consumed and concurrent builds contend, needing channel
	 *   accounts or a retry on `tx_bad_seq`. Required, and forced, when
	 *   `createUserAccount` is set: an account that does not exist yet has no
	 *   sequence number to source from.
	 * - `"user"` — opt-in, and PREFERRED once an operations account is running.
	 *   The sequence is the holder's own, so concurrent onboardings never
	 *   contend, and the sponsor can sign LAST: pair it with `buildFeeBump`
	 *   after the holder signs and the sponsor consumes no sequence at all.
	 */
	source?: "sponsor" | "user"
	/** Allow a cleartext-http RPC; defaults to localhost-only (`defaultAllowHttp`). */
	allowHttp?: boolean
}): Promise<string> {
	if (opts.source === "user" && opts.createUserAccount) {
		throw new Error(
			"source: 'user' is impossible with createUserAccount — an account that " +
				"does not exist yet has no sequence number to source a transaction",
		)
	}
	const sourceRole = opts.source ?? "sponsor"
	const sourceId = sourceRole === "sponsor" ? opts.sponsor : opts.user
	const server = new rpc.Server(opts.rpcUrl, {
		allowHttp: opts.allowHttp ?? defaultAllowHttp(opts.rpcUrl),
	})
	const src = await server.getAccount(sourceId)
	const asset = new Asset(opts.config.assetCode, opts.config.assetIssuer)
	// An operation only needs an explicit source when it differs from the
	// transaction's; naming the other party keeps the envelope minimal.
	const asSponsor = sourceRole === "sponsor" ? undefined : opts.sponsor
	const asUser = sourceRole === "user" ? undefined : opts.user
	const b = new TransactionBuilder(src, {
		fee: BASE_FEE,
		networkPassphrase: opts.networkPassphrase,
	}).addOperation(
		Operation.beginSponsoringFutureReserves({
			sponsoredId: opts.user,
			source: asSponsor,
		}),
	)
	if (opts.createUserAccount) {
		b.addOperation(
			Operation.createAccount({
				destination: opts.user,
				startingBalance: "0",
				source: asSponsor,
			}),
		)
	}
	b.addOperation(Operation.changeTrust({ asset, source: asUser }))
	b.addOperation(Operation.endSponsoringFutureReserves({ source: asUser }))
	return b.setTimeout(180).build().toXDR()
}

// The SEP-7 constants and signing payload live with the wallet-side helpers
// (sep7.ts) so the emitter and the verifier can never drift apart.
export { SEP7_MSG_MAX } from "./sep7.js"

/**
 * Signs a SEP-7 request payload. `Keypair` from `@stellar/stellar-sdk`
 * satisfies this, so an integrator can pass the keypair of the
 * `URI_REQUEST_SIGNING_KEY` published in their `stellar.toml` directly.
 */
export interface Sep7Signer {
	sign(data: Buffer): Buffer | Uint8Array
}

/**
 * Which accounts OTHER than the user must sign this envelope, and whether it
 * already carries any signature.
 *
 * A SEP-7 wallet adds the user's signature and submits. That is complete for
 * the CAP-73 router path (the holder is the sole signer) but NOT for the CAP-33
 * sponsored path, where the sponsor sources the transaction and must sign it
 * too — so we need to know the difference before handing out a link.
 */
function coSigners(
	txXdr: string,
	networkPassphrase: string,
	userAddress: string,
): { others: string[]; alreadySigned: boolean } {
	let parsed
	try {
		parsed = TransactionBuilder.fromXDR(txXdr, networkPassphrase)
	} catch (e) {
		throw new Error(
			`txXdr is not a transaction envelope for this network: ${
				e instanceof Error ? e.message : String(e)
			}`,
		)
	}
	const signers = new Set<string>()
	let signatureCount: number
	if ("innerTransaction" in parsed) {
		// Fee bump: the fee source signs the outer envelope; the inner keeps its
		// own source and per-operation signers.
		signatureCount =
			parsed.signatures.length + parsed.innerTransaction.signatures.length
		signers.add(parsed.feeSource)
		signers.add(parsed.innerTransaction.source)
		for (const op of parsed.innerTransaction.operations)
			if (op.source) signers.add(op.source)
	} else {
		signatureCount = parsed.signatures.length
		signers.add(parsed.source)
		for (const op of parsed.operations) if (op.source) signers.add(op.source)
	}
	signers.delete(userAddress)
	return { others: [...signers], alreadySigned: signatureCount > 0 }
}

export interface OnboardingRequest {
	/** SEP-7 `web+stellar:tx` URI — open in any Stellar wallet to sign once. */
	sep7Uri: string
	/**
	 * Wallet deep-link. SEP-7 IS the registered deep-link scheme, so this is
	 * the same URI as {@link sep7Uri}; it is surfaced under a second name
	 * because integrators present it in a different place (an `href` the OS
	 * routes to a wallet, rather than a QR code or copy button).
	 */
	deepLink: string
	/**
	 * Hosted activation page, prefilled for the user — present ONLY when the
	 * caller supplies `hostedBase` (an origin they control). There is no default
	 * host: an integrator must opt into a hosting origin explicitly.
	 *
	 * NOTE: unlike the two SEP-7 forms this carries only the user's ADDRESS, not
	 * `txXdr`. The hosted page re-derives the transaction from the live ledger
	 * state, which keeps the URL short enough to survive a QR code and an SMS,
	 * and avoids handing a user a transaction that has gone stale (the sponsor's
	 * sequence number moves). The three handoffs therefore accomplish the same
	 * onboarding but are NOT the same transaction.
	 */
	hostedUrl?: string
	/**
	 * The SAME SEP-7 request, wrapped for a hosted page that receives
	 * `web+stellar:` requests (the Authline activation page does:
	 * `app.html?sep7=…`). Present only with `hostedBase`. For a user whose
	 * wallet registered no `web+stellar:` handler this is the link that still
	 * works — it opens in any browser and the page hands the signature to the
	 * user's wallet (browser extension, Albedo, Nido…).
	 */
	handlerUrl?: string
}

/**
 * Turn an unsigned onboarding transaction into the handoff forms an integrator
 * can present to the user (Case B/C — user signs once).
 *
 * Pass `originDomain` + `signer` to produce a SIGNED SEP-7 request. Wallets
 * fetch `URI_REQUEST_SIGNING_KEY` from that domain's `stellar.toml` and verify
 * before they show the domain to the user; an unsigned request is displayed
 * with no verified provenance, so anything user-facing SHOULD be signed.
 *
 * CO-SIGNERS: a SEP-7 wallet adds the USER's signature and submits. The CAP-73
 * router transaction is complete at that point — the holder is its only signer.
 * The CAP-33 sponsored transaction is NOT: the sponsor sources it and must sign
 * too. Handing a wallet an unsigned sponsored envelope produces a signature
 * request that cannot succeed, so that combination is rejected here. Either
 * sign as the sponsor BEFORE building the handoff (a SEP-7 `xdr` is a full
 * `TransactionEnvelope`, so your signature travels with it and the user's
 * completes it), or pass `callback` so the wallet returns the signed XDR for
 * you to countersign and submit.
 */
export function onboardingRequest(opts: {
	txXdr: string
	networkPassphrase: string
	userAddress: string
	/**
	 * Endpoint the wallet POSTs the SIGNED transaction to instead of submitting
	 * it itself (SEP-7 `callback`). SEP-7 requires a `url:` prefix on the value;
	 * a bare URL is prefixed for you.
	 */
	callback?: string
	/** Base URL of the hosted activation page. */
	hostedBase?: string
	/**
	 * SEP-7 `pubkey`: the account expected to sign. Defaults to `userAddress`,
	 * which is right for every onboarding shape — including the sponsored one,
	 * whose envelope the sponsor sources, so a wallet must not infer the
	 * signer from the transaction source.
	 */
	pubkey?: string | null
	/**
	 * Optional human message shown by the wallet (SEP-7 `msg`). Capped by the
	 * spec at {@link SEP7_MSG_MAX} characters before URL-encoding.
	 */
	msg?: string
	/**
	 * The fully-qualified domain this request originates from (SEP-7
	 * `origin_domain`), whose `stellar.toml` publishes the
	 * `URI_REQUEST_SIGNING_KEY` that `signer` corresponds to.
	 */
	originDomain?: string
	/** Signing key for `origin_domain`. Requires `originDomain`. */
	signer?: Sep7Signer
}): OnboardingRequest {
	if (opts.msg && opts.msg.length > SEP7_MSG_MAX) {
		throw new Error(
			`msg exceeds the SEP-7 limit of ${SEP7_MSG_MAX} characters ` +
				`(got ${opts.msg.length})`,
		)
	}
	if (opts.signer && !opts.originDomain) {
		throw new Error(
			"originDomain is required when signing — a wallet verifies the " +
				"signature against URI_REQUEST_SIGNING_KEY in that domain's " +
				"stellar.toml, and has nothing to check without it",
		)
	}
	const { others, alreadySigned } = coSigners(
		opts.txXdr,
		opts.networkPassphrase,
		opts.userAddress,
	)
	if (others.length > 0 && !alreadySigned && !opts.callback) {
		throw new Error(
			`this transaction also needs a signature from ${others.join(", ")}, ` +
				"but the envelope is unsigned and no callback is set — a wallet " +
				"would add only the user's signature and submit an incomplete " +
				"transaction. Sign as those accounts before building the handoff " +
				"(the signature travels inside the SEP-7 `xdr`), or pass `callback` " +
				"so the wallet returns the signed XDR for you to countersign.",
		)
	}

	const params = new URLSearchParams()
	params.set("xdr", opts.txXdr)
	params.set("network_passphrase", opts.networkPassphrase)
	const pubkey = opts.pubkey === undefined ? opts.userAddress : opts.pubkey
	if (pubkey && StrKey.isValidEd25519PublicKey(pubkey))
		params.set("pubkey", pubkey)
	if (opts.callback) {
		// SEP-7 namespaces the callback value; only `url:` is defined today.
		params.set(
			"callback",
			opts.callback.startsWith("url:") ? opts.callback : `url:${opts.callback}`,
		)
	}
	if (opts.msg) params.set("msg", opts.msg)
	if (opts.originDomain) params.set("origin_domain", opts.originDomain)

	let sep7 = `web+stellar:tx?${params.toString()}`
	if (opts.signer) {
		const sig = opts.signer.sign(sep7SigningPayload(sep7))
		// Appended last, and by hand: the wallet recovers the payload by
		// stripping this trailing parameter, so it must stay at the end and must
		// be encoded exactly as we signed the rest.
		sep7 += `&signature=${encodeURIComponent(
			Buffer.from(sig).toString("base64"),
		)}`
	}

	const out: OnboardingRequest = { sep7Uri: sep7, deepLink: sep7 }
	if (opts.hostedBase) {
		const base = opts.hostedBase.replace(/\/$/, "")
		out.hostedUrl = `${base}?address=${encodeURIComponent(opts.userAddress)}`
		out.handlerUrl = sep7HandlerUrl(base, sep7)
	}
	return out
}

/** Convenience: rebuild a sponsor `Account` object (sequence) from a raw value. */
export function asAccount(accountId: string, sequence: string): Account {
	return new Account(accountId, sequence)
}
