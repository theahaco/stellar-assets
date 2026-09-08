import {
	assetsForNetwork,
	resolveOfficialAsset,
	netFromPassphrase,
	isValidIssuer,
	isValidContractId,
	defaultAllowHttp,
	ROUTERS,
	type AssetCapability,
	type OfficialAsset,
	type OnboarderConfig,
} from "@theahaco/authline"

/**
 * Config-driven. The network comes from PUBLIC_* env (app/.env or the Pages
 * workflow); the live assets come from the SDK registry pins for that network,
 * with PUBLIC_ASSET_* env overriding/adding the default-selected one.
 */

/**
 * Read a PUBLIC_* env var, treating a blank / whitespace-only value as unset. A
 * literal `FOO=` in a .env (or a scaffold-injected blank) loads as "", which
 * `??` would otherwise accept as a real value and defeat the intended fallback —
 * e.g. a blank `PUBLIC_ROUTER=` would suppress the pinned ROUTERS id and leave
 * the dApp showing "Activation unavailable".
 */
const env = (v: string | undefined): string | undefined => {
	const t = v?.trim()
	return t ? t : undefined
}

const RPC_URL =
	env(import.meta.env.PUBLIC_STELLAR_RPC_URL) ??
	"https://soroban-testnet.stellar.org"

const PASSPHRASE =
	env(import.meta.env.PUBLIC_STELLAR_NETWORK_PASSPHRASE) ??
	"Test SDF Network ; September 2015"

/**
 * Horizon endpoint. Only ONE thing needs it: listing the claimable balances
 * waiting for an address. Stellar RPC has no index from claimant → balances,
 * so that lookup requires an indexer; everything else on this page goes
 * through RPC. Blank it to switch the pending-balance banner off entirely.
 */
const HORIZON_URL =
	env(import.meta.env.PUBLIC_HORIZON_URL) ??
	(PASSPHRASE.includes("Public")
		? "https://horizon.stellar.org"
		: "https://horizon-testnet.stellar.org")

export const NETWORK = {
	rpcUrl: RPC_URL,
	horizonUrl: HORIZON_URL,
	passphrase: PASSPHRASE,
	// Permit cleartext http only for a local quickstart (localhost/127.0.0.1);
	// any remote endpoint stays https-only. Mirrors the SDK's defaultAllowHttp so
	// `stellar scaffold watch` against a local node works without a footgun flag.
	allowHttp: defaultAllowHttp(RPC_URL),
}

export const NETWORK_LABEL = PASSPHRASE.includes("Public")
	? "Stellar · Mainnet"
	: "Stellar · Testnet"

// Light, non-fatal validation of the wired ids — surfaces a typo'd PUBLIC_* var
// in the console instead of failing opaquely deep in transaction building.
function warnIfInvalid(
	label: string,
	value: string | undefined,
	kind: "G" | "C" | "url",
): void {
	if (!value) return
	const ok =
		kind === "G"
			? isValidIssuer(value)
			: kind === "C"
				? isValidContractId(value)
				: /^https?:\/\/\S+$/.test(value)
	if (!ok)
		console.warn(
			`[config] PUBLIC_* ${label} is not a valid ${kind === "url" ? "URL" : `${kind}-address`}: ${value}`,
		)
}
warnIfInvalid("ASSET_ISSUER", import.meta.env.PUBLIC_ASSET_ISSUER, "G")
warnIfInvalid("SAC", import.meta.env.PUBLIC_SAC, "C")
warnIfInvalid("AUTHORIZER", import.meta.env.PUBLIC_AUTHORIZER, "C")
warnIfInvalid("ROUTER", import.meta.env.PUBLIC_ROUTER, "C")
warnIfInvalid("STELLAR_RPC_URL", import.meta.env.PUBLIC_STELLAR_RPC_URL, "url")

// Resolve the pinned registry entry by (code, network) — never by code alone, so
// a known code on testnet does not pick up a mainnet asset's name/clawback flags.
// Env always wins for display; on-chain ids prefer env and fall back to the
// registry-verified pinned ids so a known asset is fully wired.
const NET_TAG = netFromPassphrase(NETWORK.passphrase)
// Network-aware default asset: mainnet showcases EURCV (the production target);
// every other network defaults to the pinned testnet test token (USDC), which
// has a real testnet issuer/SAC. So a dev pointing at testnet/local without
// setting PUBLIC_ASSET_CODE gets a working asset instead of mainnet EURCV (which
// has no testnet issuer/SAC and cannot be activated). Override with PUBLIC_ASSET_CODE.
const CODE =
	env(import.meta.env.PUBLIC_ASSET_CODE) ??
	(NET_TAG === "PUBLIC" ? "EURCV" : "USDC")
const pinned = resolveOfficialAsset(CODE, NET_TAG)

// Display glyphs. Prefix alone collides for near-identical codes (EURC and
// EURCV are both "EU"); the overrides match the long-standing roadmap glyphs.
const GLYPHS: Record<string, string> = { EURC: "EC", EURCV: "EV" }
const glyphFor = (code: string): string =>
	GLYPHS[code] ?? code.slice(0, 2).toUpperCase()

/** The live, wired asset (the one the dApp actually activates on-chain). */
export interface AssetConfig extends OnboarderConfig {
	name: string
	glyph: string
	kind: string
	networkLabel: string
	capability: AssetCapability
	/** Issuer can freeze (deauthorize) the trustline. */
	authRevocable: boolean
	/** Issuer can claw back balances — surfaced as a UI warning. */
	authClawback: boolean
}

export const ASSET: AssetConfig = {
	assetCode: CODE,
	// Prefer the registry-pinned issuer for the resolved (code, network) — the
	// hardcoded mainnet EURCV issuer is only the last-resort default and must
	// never shadow a pinned testnet entry of the same code.
	assetIssuer:
		env(import.meta.env.PUBLIC_ASSET_ISSUER) ??
		pinned?.issuer ??
		"GCEYGIVOLAVBF2TG2RUSGTUJCIN75KEX3NGLMY4VPL4GFE5L355AXW3G",
	sac: env(import.meta.env.PUBLIC_SAC) ?? pinned?.sac ?? "",
	authorizer:
		env(import.meta.env.PUBLIC_AUTHORIZER) ?? pinned?.authorizer ?? "",
	router: env(import.meta.env.PUBLIC_ROUTER) ?? ROUTERS[NET_TAG] ?? "",
	backends: ["cap73-one-signature", "cap33-sponsored"],
	name:
		env(import.meta.env.PUBLIC_ASSET_NAME) ?? pinned?.name ?? "Stellar asset",
	glyph: glyphFor(CODE),
	kind:
		env(import.meta.env.PUBLIC_ASSET_KIND) ??
		pinned?.homeDomain ??
		"Stellar asset",
	networkLabel: NETWORK_LABEL,
	capability: (env(import.meta.env.PUBLIC_AUTHORIZER)
		? "permissionedOneStep"
		: (pinned?.capability ?? "open")) as AssetCapability,
	authRevocable:
		import.meta.env.PUBLIC_ASSET_REVOCABLE === "true" ||
		(pinned?.authRevocable ?? false),
	authClawback:
		import.meta.env.PUBLIC_ASSET_CLAWBACK === "true" ||
		(pinned?.authClawback ?? false),
}

/** Wire a registry-pinned asset into a fully usable AssetConfig. */
const fromPinned = (a: OfficialAsset): AssetConfig => ({
	assetCode: a.code,
	assetIssuer: a.issuer,
	sac: a.sac,
	authorizer: a.authorizer ?? "",
	// The router is a per-network singleton — same id for every live asset.
	router: env(import.meta.env.PUBLIC_ROUTER) ?? ROUTERS[NET_TAG] ?? "",
	backends: ["cap73-one-signature", "cap33-sponsored"],
	name: a.name,
	glyph: glyphFor(a.code),
	kind: a.homeDomain ?? "Stellar asset",
	networkLabel: NETWORK_LABEL,
	capability: a.capability,
	authRevocable: a.authRevocable ?? false,
	authClawback: a.authClawback ?? false,
})

/**
 * Every asset that is LIVE on this network: the env-configured default first
 * (env still wins for bespoke deployments and the e2e build modes), then every
 * other registry-pinned asset for the network. A hosted build with no
 * PUBLIC_ASSET_* env therefore offers all pinned assets — config alone no
 * longer limits the dApp to a single activatable asset.
 */
export const LIVE_ASSETS: AssetConfig[] = [
	ASSET,
	...assetsForNetwork(NET_TAG)
		.filter((a) => a.code !== ASSET.assetCode)
		.map(fromPinned),
]

// The dedupe above is by code (the directory and pick() key tiles by code), so
// env overrides REPLACE a same-code registry pin rather than adding beside it.
// Overriding a pinned asset's issuer/SAC therefore ships a hybrid under the
// pinned name with the registry's anti-copycat protection silently dropped —
// almost certainly a deployment mistake. Warn loudly.
if (pinned) {
	const issuerOverride = env(import.meta.env.PUBLIC_ASSET_ISSUER)
	if (issuerOverride && issuerOverride !== pinned.issuer)
		console.warn(
			`[config] PUBLIC_ASSET_ISSUER (${issuerOverride}) differs from the ` +
				`registry pin for ${CODE} on ${NET_TAG} (${pinned.issuer}) — the ` +
				"pinned asset is REPLACED in the directory, not listed alongside.",
		)
	const sacOverride = env(import.meta.env.PUBLIC_SAC)
	if (sacOverride && sacOverride !== pinned.sac)
		console.warn(
			`[config] PUBLIC_SAC (${sacOverride}) differs from the registry pin ` +
				`for ${CODE} on ${NET_TAG} (${pinned.sac}).`,
		)
}

// Every activation flows through the router (which discovers the asset's
// capability on-chain) — a missing router id means activation cannot build
// transactions at all. Surface that loudly here instead of failing deep
// inside transaction building.
if (!ASSET.router)
	console.error(
		`[config] no onboard router configured for network ${NET_TAG} ` +
			`(passphrase "${NETWORK.passphrase}") — activation is unavailable. ` +
			"Use a network with a pinned ROUTERS entry (testnet) or set PUBLIC_ROUTER " +
			"to this network's router id. Note: a blank PUBLIC_ROUTER= counts as unset.",
	)

/** Directory: the configured asset is Live; the rest are the roadmap. */
export interface DirItem {
	code: string
	name: string
	glyph: string
	kind: string
	status: "live" | "soon"
	/** Issuer can claw back balances — drives the directory risk warning. */
	authClawback?: boolean
	/** Issuer can freeze (deauthorize) the trustline. */
	authRevocable?: boolean
}

// Curated roadmap items pull their real flags from the pinned registry, so a
// clawback/freeze-capable asset (e.g. EURCV) is flagged truthfully — never by
// code alone.
const fromRegistry = (code: string, glyph: string, kind: string): DirItem => {
	const a = resolveOfficialAsset(code, "PUBLIC")
	return {
		code,
		glyph,
		kind,
		name: a?.name ?? code,
		status: "soon",
		authClawback: a?.authClawback,
		authRevocable: a?.authRevocable,
	}
}

const roadmap: DirItem[] = [
	fromRegistry("USDC", "US", "USD stablecoin"),
	fromRegistry("EURC", "EC", "Euro stablecoin"),
	fromRegistry("EURCV", "EV", "MiCA euro · SG-Forge"),
	{
		code: "BENJI",
		name: "Franklin MMF",
		glyph: "BE",
		kind: "Tokenized treasuries",
		status: "soon",
	},
]

export const ASSETS: DirItem[] = [
	...LIVE_ASSETS.map((a) => ({
		code: a.assetCode,
		name: a.name,
		glyph: a.glyph,
		kind: a.kind,
		status: "live" as const,
		authClawback: a.authClawback,
		authRevocable: a.authRevocable,
	})),
	// dedupe: do not list a roadmap asset that is already live
	...roadmap.filter((r) => !LIVE_ASSETS.some((a) => a.assetCode === r.code)),
]

export const REPO_URL = "https://github.com/theahaco/authline"

/**
 * Authline relayer base URL (docs/relayer-runbook.md). The reference
 * withdrawal screen (withdraw.html) uses it as its "exchange backend": the
 * relayer builds and SIGNS the SEP-7 request (`POST /v1/sep7/request`) and
 * receives the signed envelope back (`POST /v1/sep7/callback`). Set
 * PUBLIC_RELAYER_URL=none to disable; defaults to the hosted testnet instance.
 */
const relayerEnv = env(import.meta.env.PUBLIC_RELAYER_URL)
export const RELAYER_URL: string | undefined =
	relayerEnv === "none"
		? undefined
		: (relayerEnv ??
			(NET_TAG === "TESTNET" ? "https://authline-relayer.fly.dev" : undefined))
warnIfInvalid("RELAYER_URL", RELAYER_URL, "url")

/**
 * Base domain of the Nido hosted passkey wallet (theahaco/nido). The wallets-
 * kit module derives `<base>/connect/` and `<account>.<base>/sign/` from it.
 * Nido is testnet-only today; the dApp registers its module only on testnet.
 */
export const NIDO_BASE = env(import.meta.env.PUBLIC_NIDO_BASE) ?? "nido.fyi"
