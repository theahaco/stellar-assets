import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk"
import { assetsForNetwork, type StellarNet } from "@theahaco/authline"

/** Everything the relayer needs, read once from the environment at boot. */
export interface RelayerConfig {
	network: StellarNet
	networkPassphrase: string
	rpcUrl: string
	/** Funded submitter for `authorize_trustline` — any low-privilege account. */
	signer: Keypair
	/** Optional bearer token; when set, POST /authorize requires it. */
	apiToken?: string
	port: number
	/** Asset code used when a request does not pass `?asset=`. */
	defaultAsset: string
	/**
	 * Interface to bind. `loadConfig` refuses a non-loopback bind without an
	 * `apiToken` — an open POST /authorize spends the operator's XLM.
	 */
	host?: string
	/**
	 * Per-IP request budget per minute for the /v1 routes (both of them hit
	 * RPC on the operator's quota). 0 disables. Default 120.
	 */
	rateLimitRpm?: number
	/**
	 * Cap on concurrently processed /v1 requests — an authorize can block up
	 * to 60 s awaiting confirmation, so unbounded concurrency is connection
	 * (and fee) exhaustion. Excess requests get 503 `too_busy`. Default 8.
	 */
	maxInflight?: number
	/**
	 * Read the client IP from Fly-Client-IP / X-Forwarded-For instead of the
	 * socket. Only behind a trusted reverse proxy — otherwise the header is
	 * attacker-chosen and defeats per-IP limiting.
	 */
	trustProxy?: boolean
	/**
	 * Serve `POST /v1/sep7/callback` — the SEP-7 `callback` receiver that
	 * countersigns (as fee source) and submits a router `onboard` for a
	 * smart-account holder. It is called by the USER's wallet, so it cannot
	 * carry the bearer token; it is instead bounded by shape (see
	 * `validateSep7Callback`), fee cap and the per-IP limits. Default: on for
	 * a loopback bind, off otherwise — set ALLOW_SEP7_CALLBACK=1 to enable it
	 * on a hosted instance.
	 */
	allowSep7Callback?: boolean
	/** Highest total fee (stroops) the callback will countersign. Default 0.5 XLM. */
	sep7MaxFeeStroops?: number
	/**
	 * SEP-7 `origin_domain`: the domain whose `/.well-known/stellar.toml`
	 * publishes `URI_REQUEST_SIGNING_KEY` — this relayer's own public host,
	 * since it serves that toml itself. Unset → requests go out UNSIGNED and
	 * wallets show them as unverified.
	 */
	sep7OriginDomain?: string
	/**
	 * Key that signs SEP-7 requests (published as URI_REQUEST_SIGNING_KEY).
	 * Defaults to the relayer key: signing a URI grants nothing on-chain, so a
	 * separate key is hygiene, not security.
	 */
	sep7Signer: Keypair
	/**
	 * Public base URL of this relayer, for the `callback` it puts in requests
	 * (e.g. `https://authline-relayer.fly.dev`). Defaults to
	 * `https://<sep7OriginDomain>`, else `http://<host>:<port>`.
	 */
	sep7PublicUrl: string
	/** The receiving page for `handlerUrl` (default https://authline.io/app.html). */
	sep7HandlerBase: string
	/** Per-request cap on `POST /v1/claimable/send` amounts (asset units). Default 100. */
	claimableMaxAmount?: number
}

/** The networks the relayer serves — a hosted relayer has no LOCAL story. */
type RelayerNet = "TESTNET" | "PUBLIC"

/**
 * The pinned asset (if any) whose ISSUER account is `pub`. The registry pins
 * issuer public keys, so this misconfiguration is detectable offline —
 * unlike the authorizer-admin check in `server.ts`, which needs a chain read.
 */
export function findIssuerCollision<A extends { code: string; issuer: string }>(
	pub: string,
	assets: readonly A[],
): A | undefined {
	return assets.find((a) => a.issuer === pub)
}

const DEFAULTS: Record<RelayerNet, { rpcUrl: string; passphrase: string }> = {
	TESTNET: {
		rpcUrl: "https://soroban-testnet.stellar.org",
		passphrase: Networks.TESTNET,
	},
	PUBLIC: {
		rpcUrl: "https://mainnet.sorobanrpc.com",
		passphrase: Networks.PUBLIC,
	},
}

/**
 * Parse the environment into a {@link RelayerConfig}, failing fast with a
 * message that names the variable — a relayer that boots half-configured
 * would fail later, per-request, in a way that looks like a chain problem.
 *
 * SECURITY: `RELAYER_SECRET` must be a dedicated, low-privilege operations
 * account. It pays transaction fees and nothing else — `authorize_trustline`
 * is permissionless, so this key holds no authority worth stealing. Never
 * use the authorizer admin key here.
 */
export function loadConfig(env: NodeJS.ProcessEnv): RelayerConfig {
	const netName = (env.STELLAR_NETWORK ?? "TESTNET").toUpperCase()
	if (netName !== "TESTNET" && netName !== "PUBLIC")
		throw new Error(
			`STELLAR_NETWORK must be TESTNET or PUBLIC, got '${netName}'`,
		)
	const network = netName as RelayerNet

	const secret = env.RELAYER_SECRET
	if (!secret || !StrKey.isValidEd25519SecretSeed(secret))
		throw new Error(
			"RELAYER_SECRET must be set to the S... secret of a funded, " +
				"low-privilege operations account (it only pays fees)",
		)
	const signer = Keypair.fromSecret(secret)
	const issuerCollision = findIssuerCollision(
		signer.publicKey(),
		assetsForNetwork(network),
	)
	if (issuerCollision)
		throw new Error(
			`RELAYER_SECRET is the ${issuerCollision.code} ISSUER key. Refusing ` +
				"to start: the relayer must hold a dedicated, fee-only account — " +
				"never the asset issuer key and never the authorizer admin key",
		)

	const port = Number(env.PORT ?? "8787")
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error(`PORT must be a port number, got '${env.PORT}'`)

	const defaultAsset = env.DEFAULT_ASSET ?? "EURCV"
	if (!assetsForNetwork(network).some((a) => a.code === defaultAsset))
		throw new Error(
			`DEFAULT_ASSET '${defaultAsset}' is not pinned for ${network} — ` +
				"pin it in packages/authline-sdk/src/registry.ts first",
		)

	const host = env.HOST ?? "0.0.0.0"
	const apiToken = env.RELAYER_API_TOKEN || undefined
	if (apiToken && apiToken.length < 16)
		throw new Error(
			"RELAYER_API_TOKEN must be at least 16 characters — a short token " +
				"is guessable, and it is the only thing between the internet and " +
				"your fee balance",
		)
	const loopback =
		host === "127.0.0.1" || host === "::1" || host === "localhost"
	if (!apiToken && !loopback)
		throw new Error(
			"refusing to serve a non-loopback interface without RELAYER_API_TOKEN: " +
				"an open POST /authorize lets anyone spend this account's XLM. " +
				"Set RELAYER_API_TOKEN, or bind locally with HOST=127.0.0.1",
		)

	const positiveNumber = (
		name: string,
		raw: string | undefined,
		dflt: number,
	) => {
		if (raw === undefined) return dflt
		const n = Number(raw)
		if (!Number.isFinite(n) || n <= 0)
			throw new Error(`${name} must be a positive number, got '${raw}'`)
		return n
	}
	const nonNegInt = (name: string, raw: string | undefined, dflt: number) => {
		if (raw === undefined) return dflt
		const n = Number(raw)
		if (!Number.isInteger(n) || n < 0)
			throw new Error(`${name} must be a non-negative integer, got '${raw}'`)
		return n
	}

	const sep7OriginDomain = env.SEP7_ORIGIN_DOMAIN?.trim() || undefined
	if (
		sep7OriginDomain &&
		!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
			sep7OriginDomain,
		)
	)
		throw new Error(
			`SEP7_ORIGIN_DOMAIN must be a bare domain (no scheme/path), got '${sep7OriginDomain}'`,
		)
	let sep7Signer = signer
	if (env.SEP7_SIGNING_SECRET) {
		if (!StrKey.isValidEd25519SecretSeed(env.SEP7_SIGNING_SECRET))
			throw new Error("SEP7_SIGNING_SECRET must be an S... secret seed")
		sep7Signer = Keypair.fromSecret(env.SEP7_SIGNING_SECRET)
	}
	const sep7PublicUrl = (
		env.SEP7_PUBLIC_URL?.trim() ||
		(sep7OriginDomain
			? `https://${sep7OriginDomain}`
			: `http://${host}:${port}`)
	).replace(/\/$/, "")
	if (!/^https?:\/\/\S+$/.test(sep7PublicUrl))
		throw new Error(
			`SEP7_PUBLIC_URL must be an http(s) URL, got '${sep7PublicUrl}'`,
		)
	const sep7HandlerBase =
		env.SEP7_HANDLER_BASE?.trim() || "https://authline.io/app.html"
	if (!/^https?:\/\/\S+$/.test(sep7HandlerBase))
		throw new Error(
			`SEP7_HANDLER_BASE must be an http(s) URL, got '${sep7HandlerBase}'`,
		)

	const allowSep7Callback =
		env.ALLOW_SEP7_CALLBACK === undefined
			? loopback
			: env.ALLOW_SEP7_CALLBACK === "1" || env.ALLOW_SEP7_CALLBACK === "true"

	return {
		network,
		networkPassphrase: env.NETWORK_PASSPHRASE ?? DEFAULTS[network].passphrase,
		rpcUrl: env.RPC_URL ?? DEFAULTS[network].rpcUrl,
		signer,
		apiToken,
		port,
		defaultAsset,
		host,
		rateLimitRpm: nonNegInt("RATE_LIMIT_RPM", env.RATE_LIMIT_RPM, 120),
		maxInflight: nonNegInt("MAX_INFLIGHT", env.MAX_INFLIGHT, 8),
		trustProxy: env.TRUST_PROXY === "1" || env.TRUST_PROXY === "true",
		allowSep7Callback,
		sep7MaxFeeStroops: nonNegInt(
			"SEP7_MAX_FEE_STROOPS",
			env.SEP7_MAX_FEE_STROOPS,
			5_000_000,
		),
		sep7OriginDomain,
		sep7Signer,
		sep7PublicUrl,
		sep7HandlerBase,
		claimableMaxAmount: positiveNumber(
			"CLAIMABLE_MAX_AMOUNT",
			env.CLAIMABLE_MAX_AMOUNT,
			100,
		),
	}
}
