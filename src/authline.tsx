import {
	StellarWalletsKit,
	Networks as KitNetworks,
} from "@creit.tech/stellar-wallets-kit"
import {
	AlbedoModule,
	ALBEDO_ID,
} from "@creit.tech/stellar-wallets-kit/modules/albedo"
import {
	FreighterModule,
	FREIGHTER_ID,
} from "@creit.tech/stellar-wallets-kit/modules/freighter"
import {
	HanaModule,
	HANA_ID,
} from "@creit.tech/stellar-wallets-kit/modules/hana"
import {
	LobstrModule,
	LOBSTR_ID,
} from "@creit.tech/stellar-wallets-kit/modules/lobstr"
import {
	xBullModule,
	XBULL_ID,
} from "@creit.tech/stellar-wallets-kit/modules/xbull"
import { G2cModule, G2C_ID } from "@g2c/stellar-wallets-kit-module"
import { Keypair, StrKey, rpc, TransactionBuilder } from "@stellar/stellar-sdk"
import {
	buildAuthorizeTx,
	buildClaimTx,
	buildOnboardTx,
	decodeOnboardStatus,
	describeSep7Tx,
	fetchSep7SigningKey,
	findClaimableBalances,
	getActivationStatus,
	getClaimableBalance,
	isValidIssuer,
	parseSep7TxRequest,
	planClaim,
	postSep7Callback,
	sep7Signer,
	verifySep7Signature,
	type ActivationStatus,
	type ClaimableBalanceEntry,
	type Sep7TxRequest,
	type Sep7TxSummary,
} from "@theahaco/authline"
import { useCallback, useEffect, useRef, useState } from "react"
import {
	ASSET as DEFAULT_ASSET,
	ASSETS,
	LIVE_ASSETS,
	NETWORK,
	NIDO_BASE,
	REPO_URL,
	type AssetConfig,
	type DirItem,
} from "./config.js"

// ── Warm "paper" palette (AL) ────────────────────────────────────────
const AL = {
	paper: "#F3EDE1",
	card: "#FFFFFF",
	line: "#E4DAC8",
	lineSoft: "rgba(124,108,80,0.18)",
	emerald: "#16734A",
	emeraldBright: "#1C9460",
	emeraldSoft: "#E5EFE4",
	emeraldLine: "#C2DEC6",
	ink: "#1C1813",
	mut: "#7C7264",
	mut2: "#A89C8B",
	disp: '"Bricolage Grotesque", system-ui, sans-serif',
	mono: '"IBM Plex Mono", ui-monospace, monospace',
}

const short = (s: string, a = 4, b = 4) =>
	s ? `${s.slice(0, a)}…${s.slice(-b)}` : ""
const IS_PUBLIC = NETWORK.passphrase.includes("Public")
const explorerBase = IS_PUBLIC
	? "https://stellar.expert/explorer/public"
	: "https://stellar.expert/explorer/testnet"
const txUrl = (h: string) => `${explorerBase}/tx/${h}`
const acctUrl = (a: string) =>
	`${explorerBase}/${StrKey.isValidContract(a) ? "contract" : "account"}/${a}`
/** Smart-account (C-address) holder — e.g. a Nido passkey wallet. */
const isSmartAccount = (a: string) => StrKey.isValidContract(a)

// Map the configured passphrase to the wallet kit's network. The Networks
// enum values ARE the passphrases, so an exact match is correct for public /
// testnet / futurenet / standalone — instead of collapsing every non-mainnet
// network to TESTNET, which makes wallets reject the real-passphrase tx locally.
const WALLET_NETWORK =
	(Object.values(KitNetworks).find((v) => v === NETWORK.passphrase) as
		| KitNetworks
		| undefined) ?? KitNetworks.TESTNET

// The Nido hosted wallet is TESTNET-ONLY today — register its module only
// where its accounts can actually transact.
const NIDO_AVAILABLE = NETWORK.passphrase === KitNetworks.TESTNET

// Kit v2 is a static singleton: explicit module list (allowAllModules() was
// removed), hardware/WalletConnect modules intentionally excluded as before.
StellarWalletsKit.init({
	network: WALLET_NETWORK,
	selectedWalletId: FREIGHTER_ID,
	modules: [
		...(NIDO_AVAILABLE
			? [
					new G2cModule({
						base: NIDO_BASE,
						networkPassphrase: NETWORK.passphrase,
					}),
				]
			: []),
		new FreighterModule(),
		new xBullModule(),
		new AlbedoModule(),
		new LobstrModule(),
		new HanaModule(),
	],
})

/**
 * Optional test seam: an injected signer used by the e2e browser tests so the
 * real dApp can run without a wallet extension. Inert in production (the
 * `window` hook is never set there).
 */
interface E2ESigner {
	address: string
	signTransaction(xdr: string): Promise<{ signedTxXdr: string }>
}
const e2eSigner = (): E2ESigner | undefined =>
	typeof window !== "undefined"
		? (window as unknown as { __AUTHLINE_E2E__?: E2ESigner }).__AUTHLINE_E2E__
		: undefined

/** Sign via the injected e2e signer when present, otherwise the wallet kit. */
async function signTx(xdr: string, address: string): Promise<string> {
	const e2e = e2eSigner()
	if (e2e) return (await e2e.signTransaction(xdr)).signedTxXdr
	const { signedTxXdr } = await StellarWalletsKit.signTransaction(xdr, {
		networkPassphrase: NETWORK.passphrase,
		address,
	})
	return signedTxXdr
}

// Capability-aware copy: an OPEN asset only needs its trustline CREATED. The
// transaction shape is identical either way (the router discovers capability
// on-chain); this drives COPY only.
// Assumes a live tile is never permissionedManual (no such registry entry exists); revisit the copy if one is added.
const isOpen = (a: AssetConfig) => a.capability === "open"
// No router id for this network (no pinned ROUTERS entry, no PUBLIC_ROUTER) —
// activation cannot build a transaction, so the CTA must not promise one. The
// router is a per-network singleton, so this holds for every live asset.
const ROUTER_MISSING = !DEFAULT_ASSET.router
// The asset's on-chain authorizer (its SAC admin) is known — for an existing
// unauthorized trustline the dApp can offer the direct authorize-only call
// (authorize_trustline → SAC set_authorized) instead of the full onboard.
const canAuthorize = (a: AssetConfig) => !!a.authorizer
const statusPill = (a: AssetConfig) => (isOpen(a) ? "Open" : "Auth req.")
const errorHeading = (a: AssetConfig) =>
	isOpen(a) ? "Couldn’t create trustline" : "Couldn’t authorize"

type Phase =
	| "directory"
	| "idle"
	| "ready"
	| "authorize" // trustline exists but is not authorized — offer the direct authorize call
	| "claim" // a claimable balance is waiting and can be collected in one signature
	| "sep7" // a web+stellar: request handed to this page — review it before signing
	| "building"
	| "signing"
	| "submitting"
	| "success"
	| "error"
	| "already"
	| "preview"

// ── Atoms ────────────────────────────────────────────────────────────
function Pill({
	children,
	tone = "mut",
	accent,
}: {
	children: React.ReactNode
	tone?: "mut" | "err" | "warn"
	accent?: boolean
}) {
	const map = {
		mut: { bg: "rgba(124,114,100,0.08)", fg: AL.mut, bd: AL.lineSoft },
		accent: { bg: AL.emeraldSoft, fg: AL.emeraldBright, bd: AL.emeraldLine },
		err: {
			bg: "rgba(181,83,46,0.12)",
			fg: "#B5532E",
			bd: "rgba(181,83,46,0.35)",
		},
		warn: {
			bg: "rgba(183,121,31,0.10)",
			fg: "#B7791F",
			bd: "rgba(183,121,31,0.35)",
		},
	} as const
	const c = map[accent ? "accent" : tone]
	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 7,
				whiteSpace: "nowrap",
				fontFamily: AL.mono,
				fontSize: 11,
				fontWeight: 500,
				letterSpacing: "0.08em",
				textTransform: "uppercase",
				color: c.fg,
				background: c.bg,
				border: `1px solid ${c.bd}`,
				borderRadius: 999,
				padding: "5px 11px",
			}}
		>
			{children}
		</span>
	)
}
function Dot({
	color = AL.emerald,
	size = 6,
	pulse,
}: {
	color?: string
	size?: number
	pulse?: boolean
}) {
	return (
		<span
			style={{
				width: size,
				height: size,
				borderRadius: size,
				background: color,
				flexShrink: 0,
				animation: pulse ? "alglow 1.4s ease-in-out infinite" : "none",
			}}
		/>
	)
}
function Spinner({
	color = AL.emerald,
	size = 16,
	track = "rgba(120,140,160,0.25)",
}: {
	color?: string
	size?: number
	track?: string
}) {
	return (
		<span
			className="al-spin"
			style={{
				width: size,
				height: size,
				borderRadius: size,
				display: "inline-block",
				border: `${Math.max(2, size / 7)}px solid ${track}`,
				borderTopColor: color,
				flexShrink: 0,
			}}
		/>
	)
}
function AssetGlyph({
	label = "EU",
	size = 44,
	muted = false,
}: {
	label?: string
	size?: number
	muted?: boolean
}) {
	return (
		<div
			style={{
				width: size,
				height: size,
				borderRadius: size * 0.3,
				flexShrink: 0,
				background: muted ? "rgba(124,114,100,0.08)" : AL.emeraldSoft,
				border: `1px solid ${muted ? AL.line : AL.emeraldLine}`,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontFamily: AL.disp,
				fontWeight: 700,
				fontSize: size * 0.34,
				color: muted ? AL.mut : AL.emeraldBright,
			}}
		>
			{label}
		</div>
	)
}
function KV({
	k,
	v,
	accent,
	mono = true,
}: {
	k: React.ReactNode
	v: React.ReactNode
	accent?: string
	mono?: boolean
}) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 12,
			}}
		>
			<span
				style={{
					fontFamily: AL.disp,
					fontSize: 13.5,
					color: AL.mut,
					whiteSpace: "nowrap",
					flexShrink: 0,
				}}
			>
				{k}
			</span>
			<span
				style={{
					fontFamily: mono ? AL.mono : AL.disp,
					fontSize: 13.5,
					fontWeight: 500,
					color: accent || AL.ink,
					whiteSpace: "nowrap",
				}}
			>
				{v}
			</span>
		</div>
	)
}
function Primary({
	children,
	onClick,
	disabled,
	full = true,
}: {
	children: React.ReactNode
	onClick?: () => void
	disabled?: boolean
	full?: boolean
}) {
	return (
		<button
			className="al-cta"
			onClick={onClick}
			disabled={disabled}
			style={{
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
				gap: 9,
				width: full ? "100%" : "auto",
				border: "none",
				cursor: disabled ? "default" : "pointer",
				background: disabled ? "#EAE2D4" : AL.emerald,
				color: disabled ? AL.mut : "#FFFFFF",
				fontFamily: AL.disp,
				fontWeight: 600,
				fontSize: 15,
				letterSpacing: "-0.01em",
				padding: "14px 20px",
				borderRadius: 12,
				boxShadow: disabled ? "none" : "0 8px 22px -8px rgba(22,115,74,0.55)",
			}}
		>
			{children}
		</button>
	)
}
function Ghost({
	children,
	onClick,
	full,
	href,
}: {
	children: React.ReactNode
	onClick?: () => void
	full?: boolean
	href?: string
}) {
	const style: React.CSSProperties = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 8,
		width: full ? "100%" : "auto",
		cursor: "pointer",
		background: "transparent",
		color: AL.ink,
		border: `1px solid ${AL.line}`,
		fontFamily: AL.disp,
		fontWeight: 500,
		fontSize: 14,
		padding: "13px 18px",
		borderRadius: 12,
		textDecoration: "none",
		boxSizing: "border-box",
	}
	if (href)
		return (
			<a
				className="al-cta"
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				style={style}
			>
				{children}
			</a>
		)
	return (
		<button className="al-cta" onClick={onClick} style={style}>
			{children}
		</button>
	)
}
function Divider() {
	return <div style={{ height: 1, background: AL.line, margin: "16px 0" }} />
}

/**
 * The truthful trustline state, read from the ledger: trustline existence,
 * the classic AUTHORIZED flag, and (when the asset has a SAC wired) the SAC's
 * own `authorized()` view. The SAC row goes amber when it disagrees with the
 * classic flag — for a G-account both reflect the same trustline flag, so a
 * divergence means the Soroban read failed to match the ledger.
 */
function StatusRows({
	st,
	asset,
}: {
	st: ActivationStatus | null
	asset: AssetConfig
}) {
	const amber = "#B7791F"
	// null = the ledger read failed or hasn't happened — unknown, never "None".
	if (!st) {
		return (
			<>
				<KV k="Trustline" v="—" accent={AL.mut} mono={false} />
				<KV k="Authorized" v="—" accent={AL.mut} mono={false} />
				{asset.sac && (
					<KV k="SAC authorized" v="—" accent={AL.mut} mono={false} />
				)}
			</>
		)
	}
	// Smart accounts (C-addresses) have no trustline concept — their balance +
	// authorization live in the SAC's contract storage. Render that truthfully.
	if (st.holderKind === "contract") {
		return (
			<>
				<KV k="Holder" v="● Smart account" accent={AL.mut} mono={false} />
				<KV k="Trustline" v="Not needed" accent={AL.mut} mono={false} />
				<KV
					k="SAC authorized"
					v={
						st.sacAuthorized === undefined
							? "—"
							: st.sacAuthorized
								? "● Yes"
								: "No"
					}
					accent={st.sacAuthorized ? AL.emeraldBright : undefined}
					mono={false}
				/>
			</>
		)
	}
	const trustline = st.hasTrustline
		? st.isAuthorized
			? { v: "● Active", c: AL.emeraldBright }
			: { v: "● Created — not authorized", c: amber }
		: { v: "● None", c: AL.mut }
	// Partial authorization (maintain liabilities only — e.g. a frozen line) is
	// a distinct compliance state; never render it as plain "No".
	const authorized = st.isAuthorized
		? { v: "● Yes", c: AL.emeraldBright }
		: st.isAuthorizedToMaintainLiabilities
			? { v: "Partial — maintain only", c: amber }
			: { v: "No", c: undefined }
	const sacKnown = st.sacAuthorized !== undefined
	const sacDiverges = sacKnown && st.sacAuthorized !== st.isAuthorized
	return (
		<>
			<KV k="Trustline" v={trustline.v} accent={trustline.c} mono={false} />
			<KV k="Authorized" v={authorized.v} accent={authorized.c} mono={false} />
			{asset.sac && (
				<KV
					k="SAC authorized"
					v={!sacKnown ? "—" : st.sacAuthorized ? "● Yes" : "No"}
					accent={
						sacDiverges
							? amber
							: st.sacAuthorized
								? AL.emeraldBright
								: undefined
					}
					mono={false}
				/>
			)}
		</>
	)
}

// ── Wallet modal (wired to Stellar Wallets Kit) ──────────────────────
const WALLETS: [string, string, string][] = [
	// Nido is a hosted passkey smart wallet (testnet-only today) — its module
	// is registered only on testnet, so the row is gated the same way.
	...(NIDO_AVAILABLE
		? ([["Nido", G2C_ID, "Passkey"]] as [string, string, string][])
		: []),
	["Freighter", FREIGHTER_ID, "Extension"],
	["xBull", XBULL_ID, "Extension"],
	["Albedo", ALBEDO_ID, "Web"],
	["Lobstr", LOBSTR_ID, "Mobile"],
	["Hana", HANA_ID, "Extension"],
]
function WalletModal({
	onPick,
	onClose,
	available,
}: {
	onPick: (id: string) => void
	onClose: () => void
	available: Set<string>
}) {
	// Now that the modal can open unprompted (connect-on-open), it needs real
	// dialog semantics: Escape closes it like the backdrop/× do.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose()
		}
		window.addEventListener("keydown", onKey)
		return () => window.removeEventListener("keydown", onKey)
	}, [onClose])
	return (
		<div
			onClick={onClose}
			role="dialog"
			aria-modal="true"
			aria-label="Connect a wallet"
			style={{
				position: "absolute",
				inset: 0,
				zIndex: 30,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				padding: 24,
				background: "rgba(40,30,15,0.45)",
				backdropFilter: "blur(3px)",
			}}
		>
			<div
				className="al-fade"
				onClick={(e) => e.stopPropagation()}
				style={{
					width: "100%",
					maxWidth: 360,
					background: AL.card,
					borderRadius: 18,
					border: `1px solid ${AL.line}`,
					padding: 22,
					boxShadow: "0 30px 80px -30px rgba(40,30,15,0.35)",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						marginBottom: 16,
					}}
				>
					<div
						style={{
							fontFamily: AL.disp,
							fontWeight: 600,
							fontSize: 17,
							color: AL.ink,
						}}
					>
						Connect a wallet
					</div>
					<button
						className="al-cta"
						onClick={onClose}
						aria-label="Close"
						style={{
							width: 28,
							height: 28,
							borderRadius: 8,
							border: `1px solid ${AL.line}`,
							background: "transparent",
							cursor: "pointer",
							color: AL.mut,
							fontSize: 16,
							lineHeight: 1,
						}}
					>
						×
					</button>
				</div>
				<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
					{WALLETS.map(([w, id, tag]) => {
						const det = available.has(id)
						return (
							<button
								key={id}
								className="al-wrow al-cta"
								onClick={() => onPick(id)}
								style={{
									display: "flex",
									alignItems: "center",
									gap: 12,
									padding: "11px 13px",
									borderRadius: 12,
									border: `1px solid ${AL.line}`,
									background: "rgba(124,114,100,0.04)",
									cursor: "pointer",
									textAlign: "left",
								}}
							>
								<span
									style={{
										width: 30,
										height: 30,
										borderRadius: 9,
										background: "rgba(124,114,100,0.10)",
										flexShrink: 0,
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										fontFamily: AL.disp,
										fontWeight: 700,
										fontSize: 13,
										color: AL.mut,
									}}
								>
									{w[0]}
								</span>
								<span
									style={{
										fontFamily: AL.disp,
										fontWeight: 500,
										fontSize: 14.5,
										color: AL.ink,
									}}
								>
									{w}
								</span>
								<span
									style={{
										marginLeft: "auto",
										fontFamily: AL.mono,
										fontSize: 10.5,
										letterSpacing: "0.06em",
										textTransform: "uppercase",
										color: det ? AL.emeraldBright : AL.mut2,
									}}
								>
									{det ? "● Detected" : tag}
								</span>
							</button>
						)
					})}
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 12,
						color: AL.mut2,
						textAlign: "center",
						margin: "16px 0 2px",
						lineHeight: 1.4,
					}}
				>
					Non-custodial — Authline never holds your keys.
				</p>
			</div>
		</div>
	)
}

// ── Progress (build → sign → submit) ─────────────────────────────────
const STEPS: [Phase, string][] = [
	["building", "Preparing"],
	["signing", "Sign"],
	["submitting", "Submitting"],
]
function Progress({ state }: { state: Phase }) {
	const idx = STEPS.findIndex(([s]) => s === state)
	return (
		<div style={{ display: "flex", gap: 7, margin: "4px 0 18px" }}>
			{STEPS.map(([s, label], i) => {
				const active = i === idx,
					doneStep = i < idx
				return (
					<div key={s} style={{ flex: 1 }}>
						<div
							style={{
								height: 4,
								borderRadius: 4,
								background: doneStep
									? AL.emerald
									: active
										? AL.emeraldLine
										: AL.line,
								overflow: "hidden",
								position: "relative",
							}}
						>
							{active && (
								<div
									style={{
										position: "absolute",
										inset: 0,
										background: AL.emerald,
										transformOrigin: "left",
										animation: "albar 1.1s ease-out forwards",
									}}
								/>
							)}
						</div>
						<div
							style={{
								fontFamily: AL.mono,
								fontSize: 9.5,
								letterSpacing: "0.08em",
								textTransform: "uppercase",
								marginTop: 7,
								color: doneStep || active ? AL.emeraldBright : AL.mut2,
							}}
						>
							{label}
						</div>
					</div>
				)
			})}
		</div>
	)
}

function AssetRow({
	status,
	asset,
}: {
	status: React.ReactNode
	asset: AssetConfig
}) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 13,
				marginBottom: 18,
			}}
		>
			<AssetGlyph label={asset.glyph} />
			<div style={{ lineHeight: 1.3, minWidth: 0 }}>
				<div
					style={{
						fontFamily: AL.disp,
						fontWeight: 600,
						fontSize: 17,
						color: AL.ink,
					}}
				>
					{asset.assetCode}
				</div>
				<div
					style={{
						fontFamily: AL.disp,
						fontSize: 12.5,
						color: AL.mut,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis",
					}}
				>
					{asset.name}
				</div>
				{(asset.authClawback || asset.authRevocable) && (
					<div
						style={{
							fontFamily: AL.disp,
							fontSize: 11.5,
							color: "#B7791F",
							marginTop: 3,
							display: "flex",
							alignItems: "center",
							gap: 4,
						}}
					>
						<span aria-hidden>⚠</span>{" "}
						{asset.authClawback
							? "Issuer can freeze or claw back this asset"
							: "Issuer can freeze this asset"}
					</div>
				)}
			</div>
			<div style={{ marginLeft: "auto", flexShrink: 0 }}>{status}</div>
		</div>
	)
}
function Card({ children }: { children: React.ReactNode }) {
	return (
		<div
			style={{
				width: "100%",
				maxWidth: 384,
				background: AL.card,
				borderRadius: 20,
				border: `1px solid ${AL.line}`,
				padding: 26,
				boxShadow: "0 30px 70px -34px rgba(40,30,15,0.3)",
			}}
		>
			{children}
		</div>
	)
}

/** Whether a status read means "this holder is authorized for the asset". */
const isAuthorizedStatus = (st: ActivationStatus): boolean =>
	st.holderKind === "contract" ? !!st.sacAuthorized : st.isAuthorized

/** The per-tile wallet badge: live activation state at a glance. */
function DirStatusPill({ st }: { st: ActivationStatus | "loading" }) {
	if (st === "loading")
		return (
			<span title="Checking this asset for your wallet…">
				<Pill>
					<Spinner size={10} /> …
				</Pill>
			</span>
		)
	if (!classicReadOk(st))
		return (
			<span title="Could not read this asset's status — try reconnecting">
				<Pill>—</Pill>
			</span>
		)
	if (isAuthorizedStatus(st))
		return (
			<Pill accent>
				<Dot /> Authorized
			</Pill>
		)
	if (st.isAuthorizedToMaintainLiabilities)
		return (
			<span title="Partially authorized (maintain liabilities only) — e.g. frozen">
				<Pill tone="warn">
					<Dot color="#B7791F" /> Partial
				</Pill>
			</span>
		)
	if (st.hasTrustline)
		return (
			<Pill tone="warn">
				<Dot color="#B7791F" /> Trustline only
			</Pill>
		)
	return <Pill>Not active</Pill>
}

function Directory({
	onPick,
	statuses,
	pendingCounts,
}: {
	onPick: (a: DirItem) => void
	/** Per-asset status for the connected/previewed wallet; absent = show "Live". */
	statuses?: Record<string, ActivationStatus | "loading">
	/** Claimable balances waiting per asset code — badged so they're findable. */
	pendingCounts?: Record<string, number>
}) {
	return (
		<div className="al-fade">
			<div
				style={{
					fontFamily: AL.mono,
					fontSize: 11,
					letterSpacing: "0.14em",
					textTransform: "uppercase",
					color: AL.mut2,
					marginBottom: 14,
				}}
			>
				Supported assets
			</div>
			<div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
				{ASSETS.map((a) => {
					const live = a.status === "live"
					return (
						<button
							key={a.code}
							className={live ? "al-wrow al-cta" : ""}
							onClick={() => onPick(a)}
							disabled={!live}
							style={{
								display: "flex",
								alignItems: "center",
								gap: 13,
								padding: "12px 13px",
								borderRadius: 13,
								border: `1px solid ${AL.line}`,
								background: live ? "rgba(124,114,100,0.04)" : "transparent",
								cursor: live ? "pointer" : "default",
								opacity: live ? 1 : 0.5,
								textAlign: "left",
							}}
						>
							<AssetGlyph label={a.glyph} size={40} muted={!live} />
							<div style={{ lineHeight: 1.3, minWidth: 0 }}>
								<div
									style={{
										fontFamily: AL.disp,
										fontWeight: 600,
										fontSize: 15.5,
										color: AL.ink,
									}}
								>
									{a.code}
								</div>
								<div
									style={{
										fontFamily: AL.disp,
										fontSize: 12.5,
										color: AL.mut,
										whiteSpace: "nowrap",
										overflow: "hidden",
										textOverflow: "ellipsis",
									}}
								>
									{a.name} · {a.kind}
								</div>
								{a.authClawback && (
									<div
										style={{
											fontFamily: AL.disp,
											fontSize: 11.5,
											color: "#B7791F",
											marginTop: 2,
											display: "flex",
											alignItems: "center",
											gap: 4,
										}}
									>
										<span aria-hidden>⚠</span> Issuer can freeze or claw back
									</div>
								)}
							</div>
							<div
								style={{
									marginLeft: "auto",
									flexShrink: 0,
									display: "flex",
									alignItems: "center",
									gap: 9,
								}}
							>
								{live && pendingCounts?.[a.code] ? (
									// A balance is waiting for this wallet — say so on the
									// directory, or the user never knows to click in.
									<span
										title={`${pendingCounts[a.code]} claimable balance(s) waiting for you`}
									>
										<Pill accent>
											<Dot /> {pendingCounts[a.code]} to claim
										</Pill>
									</span>
								) : live ? (
									statuses?.[a.code] !== undefined ? (
										<DirStatusPill st={statuses[a.code]!} />
									) : (
										<Pill accent>
											<Dot /> Live
										</Pill>
									)
								) : (
									<Pill>Soon</Pill>
								)}
								{live && (
									<span style={{ color: AL.mut2, fontSize: 17, lineHeight: 1 }}>
										›
									</span>
								)}
							</div>
						</button>
					)
				})}
			</div>
		</div>
	)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Read the full activation status (classic flags + SAC view) for an account. */
const fetchStatus = (
	account: string,
	asset: AssetConfig,
): Promise<ActivationStatus> =>
	getActivationStatus({
		rpcUrl: NETWORK.rpcUrl,
		allowHttp: NETWORK.allowHttp,
		account,
		assetCode: asset.assetCode,
		assetIssuer: asset.assetIssuer,
		sac: asset.sac || undefined,
		networkPassphrase: NETWORK.passphrase,
	})

/** The truthful phase for a connected account's on-ledger state. */
const phaseFor = (st: ActivationStatus, asset: AssetConfig): Phase => {
	// Smart accounts have no trustline; the SAC view is the state. The
	// authorize-only path is classic-tooling — the router onboard covers both.
	if (st.holderKind === "contract")
		return st.sacAuthorized ? "already" : "ready"
	return st.isAuthorized
		? "already"
		: st.hasTrustline && canAuthorize(asset)
			? "authorize"
			: "ready"
}

/**
 * Whether the classic-flags part of a status read is trustworthy. The SDK
 * never rejects on a transient read failure — it resolves `{ false, false,
 * readError }` — so an all-false status WITH a readError must be treated as
 * unknown, never stored or rendered as a definitive "no trustline". (A
 * readError alongside hasTrustline=true means only the best-effort SAC view
 * failed; the classic flags are still authoritative.)
 */
const classicReadOk = (st: ActivationStatus): boolean =>
	st.holderKind === "contract"
		? !st.readError // contracts: the SAC view is the only read — failed ⇒ unknown
		: !st.readError || st.hasTrustline

/**
 * Submit a signed tx and poll for confirmation. Bounded: a tx that never
 * lands must surface an error instead of leaving the UI stuck on
 * "Submitting…" forever.
 */
async function submitAndConfirm(signedTxXdr: string) {
	const server = new rpc.Server(NETWORK.rpcUrl, {
		allowHttp: NETWORK.allowHttp,
	})
	const sent = await server.sendTransaction(
		TransactionBuilder.fromXDR(signedTxXdr, NETWORK.passphrase),
	)
	if (sent.status === "ERROR") throw new Error("Transaction submission failed")
	const deadline = Date.now() + 180_000
	let got = await server.getTransaction(sent.hash)
	while (got.status === "NOT_FOUND" && Date.now() < deadline) {
		await sleep(1100)
		got = await server.getTransaction(sent.hash)
	}
	if (got.status === "NOT_FOUND")
		throw new Error("Transaction not confirmed within 180s — try again")
	// Compare against the enum (not the string literal) so TypeScript
	// narrows `got` to GetSuccessfulTransactionResponse → `returnValue`.
	if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS)
		throw new Error(`Transaction ${got.status.toLowerCase()}`)
	return { hash: sent.hash, returnValue: got.returnValue }
}

/** Live asset preselected by a ?asset=CODE deep link, if any. */
const preselectedAsset = (): AssetConfig | undefined => {
	const q = new URLSearchParams(window.location.search).get("asset")
	return LIVE_ASSETS.find((a) => a.assetCode === q)
}

// ── SEP-7 receiving end ──────────────────────────────────────────────
/**
 * A `web+stellar:tx` request handed to this page (`app.html?sep7=…`): a third
 * party — an exchange's withdrawal screen, typically — built a transaction
 * with `@theahaco/authline` and asks the user to sign it here with whichever
 * wallet they connect. This page is the WALLET side of the SEP-7 handoff, for
 * users whose wallet registers no `web+stellar:` handler of its own.
 */
interface Sep7Ctx {
	req: Sep7TxRequest
	summary: Sep7TxSummary
	/** The account the request wants to sign. */
	signer: string
	/** The live asset it activates, when it is a router onboard for a pinned SAC. */
	asset?: AssetConfig
}
type Sep7Verify =
	| { state: "unsigned" } // no origin_domain — nothing to verify against
	| { state: "checking" }
	| { state: "verified"; key: string }
	| { state: "unverified"; reason: string }
	| { state: "forged" }

function readSep7FromUrl(): { ctx: Sep7Ctx } | { error: string } | null {
	// Read the raw query, not URLSearchParams: a request pasted UNENCODED into
	// the URL would have its `+` (in `web+stellar` and in base64) read as spaces.
	const m = /[?&]sep7=([^&#]*)/.exec(window.location.search)
	if (!m) return null
	const encoded = m[1] ?? ""
	let raw: string
	try {
		raw = decodeURIComponent(encoded)
	} catch {
		raw = encoded
	}
	try {
		const req = parseSep7TxRequest(raw, {
			networkPassphrase: NETWORK.passphrase,
		})
		const summary = describeSep7Tx(req.xdr, NETWORK.passphrase)
		// The asset this request activates: the router onboard's SAC (Case C),
		// or the ChangeTrust inside a sponsored CAP-33 sandwich (Case B).
		const sac = summary.onboard?.sac
		const trust = summary.ops.find((o) => o.asset)?.asset
		const asset = sac
			? LIVE_ASSETS.find((a) => a.sac === sac)
			: trust
				? LIVE_ASSETS.find(
						(a) => a.assetCode === trust.code && a.assetIssuer === trust.issuer,
					)
				: undefined
		return { ctx: { req, summary, signer: sep7Signer(req, summary), asset } }
	} catch (e) {
		return {
			error: `This link is not a signable SEP-7 request — ${
				e instanceof Error ? e.message : String(e)
			}.`,
		}
	}
}
const initialSep7Verify = (ctx: Sep7Ctx | null): Sep7Verify => {
	if (!ctx?.req.originDomain) return { state: "unsigned" }
	if (!ctx.req.signature)
		return {
			state: "unverified",
			reason: `${ctx.req.originDomain} did not sign this request`,
		}
	return { state: "checking" }
}
const stroopsToXlm = (s: string) =>
	(Number(s) / 1e7).toFixed(7).replace(/0+$/, "").replace(/\.$/, "")
/** Offer to make this page the browser's web+stellar: handler (secure contexts only). */
const canRegisterHandler = () =>
	typeof navigator !== "undefined" &&
	"registerProtocolHandler" in navigator &&
	window.isSecureContext
const registerSep7Handler = () => {
	try {
		navigator.registerProtocolHandler(
			"web+stellar",
			`${window.location.origin}${window.location.pathname}?sep7=%s`,
		)
	} catch (e) {
		console.warn("registerProtocolHandler failed", e)
	}
}

export function AuthlineApp() {
	const [address, setAddress] = useState("")
	// A SEP-7 request handed to this page (`?sep7=web+stellar:tx?…`) — read
	// once; the page then acts as the receiving end of the handoff.
	const [sep7] = useState(() => readSep7FromUrl())
	const sep7Ctx = sep7 && "ctx" in sep7 ? sep7.ctx : null
	// The asset being activated. Defaults to the env-configured asset; a
	// ?asset=CODE deep link (landing page, partner docs) preselects any live
	// asset and skips straight past the directory.
	const [asset, setAsset] = useState<AssetConfig>(
		() => sep7Ctx?.asset ?? preselectedAsset() ?? DEFAULT_ASSET,
	)
	const [phase, setPhase] = useState<Phase>(() =>
		sep7
			? sep7Ctx
				? "sep7"
				: "error"
			: preselectedAsset()
				? "idle"
				: "directory",
	)
	const [showModal, setShowModal] = useState(false)
	const [hash, setHash] = useState<string | null>(null)
	const [errMsg, setErrMsg] = useState(() =>
		sep7 && "error" in sep7 ? sep7.error : "",
	)
	// Provenance of the SEP-7 request: origin_domain signature verification.
	const [sep7Verify, setSep7Verify] = useState<Sep7Verify>(() =>
		initialSep7Verify(sep7Ctx),
	)
	// Whether the signed request went back to its sender's callback (which then
	// submitted it) rather than being submitted from here.
	const [sep7Returned, setSep7Returned] = useState(false)
	// Truthful router outcome: trustline created but NOT authorized (the asset
	// has no one-step authorizer) — drives the success copy.
	const [trustlineOnly, setTrustlineOnly] = useState(false)
	// Last RELIABLE ledger read for `address` (classic flags + SAC view);
	// null = unread or the read failed (unknown — never claimed as "none").
	const [status, setStatus] = useState<ActivationStatus | null>(null)
	// Stale-async guard: bumped whenever the account context changes (connect,
	// back). In-flight status reads from a previous generation must not commit
	// state — otherwise a slow read for account A lands after connecting B and
	// pairs B's address with A's status.
	const statusGen = useRef(0)
	// Whether `address` came from a wallet connection (vs the read-only
	// ?address= preview) — only a connected wallet may reach signing phases.
	const isConnected = useRef(false)
	// Smart-account activation needs a G fee payer (a contract cannot source a
	// transaction). One ephemeral friendbot-funded key per SESSION (not per
	// attempt — friendbot rate-limits, and stranding 10k test-XLM per retry is
	// rude), plus a pre-built onboard tx: the Nido sign POPUP must open within
	// the click's transient-user-activation window (~5s), so friendbot + RPC
	// round-trips cannot run between click and window.open. The prep runs in
	// the background when a smart account lands on "ready".
	const smartFee = useRef<Keypair | null>(null)
	const smartPrep = useRef<{
		xdr: string
		assetCode: string
		holder: string
		expiresAt: number
	} | null>(null)
	// Per-asset activation status for the connected (or previewed) wallet,
	// shown as directory badges. Keyed by asset code; "loading" while a read is
	// in flight. Guarded by its OWN generation (dirGen): unlike statusGen it
	// must survive pick()/activate() bumps — badges belong to the ADDRESS, not
	// to the selected asset.
	const [dirStatuses, setDirStatuses] = useState<
		Record<string, ActivationStatus | "loading">
	>({})
	const dirGen = useRef(0)
	// Origin of the last FAILED connect — routes a retry back to the directory
	// instead of dumping the user into the default asset's flow.
	const failedFromDirectory = useRef(false)
	const loadDirectoryStatuses = useCallback(
		(addr: string): Record<string, Promise<ActivationStatus>> => {
			const gen = ++dirGen.current
			setDirStatuses(
				Object.fromEntries(LIVE_ASSETS.map((a) => [a.assetCode, "loading"])),
			)
			const reads: Record<string, Promise<ActivationStatus>> = {}
			for (const a of LIVE_ASSETS) {
				const read = fetchStatus(addr, a)
				reads[a.assetCode] = read
				read
					.then((st) => {
						if (gen !== dirGen.current) return
						// Fill only while still "loading": a fresher write (e.g. the
						// post-activation merge in refreshStatus) must never be
						// clobbered by a slow connect-time read resolving late.
						setDirStatuses((prev) =>
							prev[a.assetCode] === "loading"
								? { ...prev, [a.assetCode]: st }
								: prev,
						)
					})
					.catch(() => {
						// Defensive only — the SDK resolves with readError on transient
						// failures (rendered as "—") and rejects solely on static
						// misconfiguration. Drop the spinner if it ever happens.
						if (gen !== dirGen.current) return
						setDirStatuses((prev) => {
							if (prev[a.assetCode] !== "loading") return prev
							const next = { ...prev }
							delete next[a.assetCode]
							return next
						})
					})
			}
			return reads
		},
		[],
	)
	const [available, setAvailable] = useState<Set<string>>(new Set())
	// wallet availability for the modal detection dots
	useEffect(() => {
		let cancelled = false
		StellarWalletsKit.refreshSupportedWallets()
			.then((ws) => {
				if (!cancelled)
					setAvailable(
						new Set(ws.filter((w) => w.isAvailable).map((w) => w.id)),
					)
			})
			.catch(() => {})
		return () => {
			cancelled = true
		}
	}, [])

	// ?address=… read-only preview
	useEffect(() => {
		let cancelled = false
		if (sep7) return // a SEP-7 request owns the page: no preview, no prompt
		const a = new URLSearchParams(window.location.search).get("address")
		if (a && (isValidIssuer(a) || StrKey.isValidContract(a))) {
			const gen = statusGen.current
			setAddress(a)
			loadDirectoryStatuses(a) // badge the directory for the previewed wallet
			fetchStatus(a, asset)
				.then((st) => {
					if (cancelled || gen !== statusGen.current) return
					if (classicReadOk(st)) {
						setStatus(st)
						setPhase(
							(
								st.holderKind === "contract"
									? st.sacAuthorized
									: st.isAuthorized
							)
								? "already"
								: "preview",
						)
					} else {
						setPhase("preview") // status stays null → rendered as unknown
					}
				})
				.catch(() => {
					if (!cancelled && gen === statusGen.current) setPhase("preview")
				})
		}
		return () => {
			cancelled = true
		}
		// Mount-only by design: the preview reads the URL-selected (or default)
		// asset once. Re-running on tile picks would clobber the picked phase
		// with a stale ?address= preview.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Connect-on-open: prompt for a wallet immediately so the directory shows
	// what's already authorized — instead of making users click into every
	// asset to find out. Dismissible (the header Connect button remains), once
	// per session (no nagging on every reload); a VALID ?address= preview
	// already carries its own wallet context (same validation as the preview
	// effect — a malformed param must not silently suppress the prompt).
	useEffect(() => {
		if (sep7) return // the request screen has its own connect button
		const a = new URLSearchParams(window.location.search).get("address")
		if (a && (isValidIssuer(a) || StrKey.isValidContract(a))) return
		if (isConnected.current || address) return
		const KEY = "authline:connect-prompted"
		try {
			if (sessionStorage.getItem(KEY)) return
			sessionStorage.setItem(KEY, "1")
		} catch {
			// storage unavailable (e.g. blocked) — still prompt
		}
		setShowModal(true)
		// Mount-only: re-running would reopen the modal on every state change.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [])

	// Verify the SEP-7 request's provenance: fetch origin_domain's stellar.toml
	// and check `signature` against URI_REQUEST_SIGNING_KEY. Best-effort — a
	// toml this browser cannot read (CORS, offline) is "unverified", never
	// "forged"; only a key that exists and does NOT match is forged.
	useEffect(() => {
		const originDomain = sep7Ctx?.req.originDomain
		const uri = sep7Ctx?.req.uri
		if (!originDomain || !uri || !sep7Ctx?.req.signature) return
		let cancelled = false
		fetchSep7SigningKey(originDomain)
			.then((key) => {
				if (cancelled) return
				if (!key)
					setSep7Verify({
						state: "unverified",
						reason: `${originDomain} publishes no URI_REQUEST_SIGNING_KEY`,
					})
				else if (verifySep7Signature(uri, key))
					setSep7Verify({ state: "verified", key })
				else setSep7Verify({ state: "forged" })
			})
			.catch(() => {
				if (!cancelled)
					setSep7Verify({
						state: "unverified",
						reason: `could not read ${originDomain}’s stellar.toml from this browser`,
					})
			})
		return () => {
			cancelled = true
		}
	}, [sep7Ctx])

	// Background prep for smart-account activation: fund the session fee payer
	// (once) and pre-build the onboard tx, so that when the user clicks
	// Activate the Nido sign POPUP opens within the click's transient-user-
	// activation window — friendbot + RPC round-trips after the click would
	// get the popup blocked. Re-run whenever a smart account lands on "ready".
	const prepareSmartActivation = useCallback(
		async (holder: string, a: AssetConfig) => {
			if (NETWORK.passphrase !== KitNetworks.TESTNET) return
			try {
				if (!smartFee.current) {
					const kp = Keypair.random()
					const fb = await fetch(
						`https://friendbot.stellar.org/?addr=${kp.publicKey()}`,
					)
					if (!fb.ok) return
					smartFee.current = kp
				}
				const xdr = await buildOnboardTx({
					rpcUrl: NETWORK.rpcUrl,
					networkPassphrase: NETWORK.passphrase,
					holder,
					feeSource: smartFee.current.publicKey(),
					config: a,
					allowHttp: NETWORK.allowHttp,
				})
				// Refresh well before the tx's own 180s timeout.
				smartPrep.current = {
					xdr,
					assetCode: a.assetCode,
					holder,
					expiresAt: Date.now() + 120_000,
				}
			} catch {
				// Best-effort: activate() falls back to building inline.
				smartPrep.current = null
			}
		},
		[],
	)

	const connect = useCallback(
		async (id: string) => {
			// New account context: invalidate any in-flight status read (a slow read
			// for the previous address must not pair with the new one), and close the
			// modal up front so a stalled wallet popup can't spawn a second connect.
			const gen = ++statusGen.current
			// Connecting from the DIRECTORY (auto-modal / header Connect) returns
			// to the directory so the badges are the payoff — only an asset-first
			// flow (?asset deep link, tile pick) routes into that asset's screen.
			// A retry from a directory-origin connect failure counts as directory.
			const fromDirectory =
				phase === "directory" ||
				(phase === "error" && !address && failedFromDirectory.current)
			setShowModal(false)
			let addrForSep7: string | undefined
			try {
				const e2e = e2eSigner()
				let addr: string
				if (e2e) {
					addr = e2e.address
				} else {
					// Clear any previous module selection + per-module address cache
					// (e.g. Nido's localStorage'd account) so reconnecting always asks
					// the wallet — this is also the only way to switch Nido accounts.
					await StellarWalletsKit.disconnect().catch(() => {})
					StellarWalletsKit.setWallet(id)
					// fetchAddress (not getAddress): pull from the wallet itself on a
					// fresh connect rather than the kit's cached memory.
					addr = (await StellarWalletsKit.fetchAddress()).address
				}
				if (gen !== statusGen.current) return
				addrForSep7 = addr
				isConnected.current = true
				setAddress(addr)
				setStatus(null)
				// Fill the directory badges in parallel; the selected asset's read is
				// part of that burst — reuse it instead of issuing a duplicate.
				const reads = loadDirectoryStatuses(addr)
				const st = await (reads[asset.assetCode] ?? fetchStatus(addr, asset))
				if (gen !== statusGen.current) return
				if (classicReadOk(st)) {
					setStatus(st)
					if (sep7Ctx) {
						setPhase("sep7") // back to the request, now with a wallet to sign
					} else if (fromDirectory) {
						setPhase("directory")
					} else {
						setPhase(phaseFor(st, asset))
						// Pre-build the smart-account activation so the eventual click
						// opens the wallet popup within the user-activation window.
						if (st.holderKind === "contract" && !st.sacAuthorized)
							void prepareSmartActivation(addr, asset)
					}
				} else if (sep7Ctx) {
					setPhase("sep7")
				} else if (fromDirectory) {
					setPhase("directory")
				} else {
					// Unknown ledger state: offer the normal activate flow (the router
					// call is idempotent) instead of asserting "no trustline".
					setPhase("ready")
					if (isSmartAccount(addr)) void prepareSmartActivation(addr, asset)
				}
			} catch (e) {
				if (gen !== statusGen.current) return
				// A SEP-7 request needs the wallet, not a status read: an account
				// that does not exist yet (Case B — sponsored creation) reads as an
				// error here, and the request is still perfectly signable.
				if (sep7Ctx && addrForSep7) {
					isConnected.current = true
					setAddress(addrForSep7)
					setStatus(null)
					setPhase("sep7")
					return
				}
				// The kit's selected module already switched — without a rollback,
				// "Try again" would pair the PREVIOUS address with the NEW module
				// (wrong-wallet signing). Clear the pairing instead — INCLUDING the
				// badge map, which may still describe a previewed/previous address.
				isConnected.current = false
				dirGen.current++
				setDirStatuses({})
				setAddress("")
				setStatus(null)
				// Remember the origin: a retry-connect from this error screen should
				// land back where the user started (directory vs asset flow).
				failedFromDirectory.current = fromDirectory
				setErrMsg(e instanceof Error ? e.message : String(e))
				setPhase("error")
			}
		},
		[
			asset,
			phase,
			address,
			sep7Ctx,
			prepareSmartActivation,
			loadDirectoryStatuses,
		],
	)

	const pick = (t: DirItem) => {
		if (t.status !== "live") return
		const next = LIVE_ASSETS.find((a) => a.assetCode === t.code)
		if (!next) return
		// New asset context: the stored status belongs to the previous asset —
		// invalidate in-flight reads and re-read for the selection.
		const gen = ++statusGen.current
		setAsset(next)
		setStatus(null)
		// A ?address= preview address is NOT a connected wallet — it must go
		// through the connect flow, not straight to signing-capable phases.
		if (!(address && isConnected.current)) {
			setPhase("idle")
			return
		}
		// Seed from the directory badge when available: a tile already marked
		// "Authorized" must not flash the provisional Activate screen.
		const seed = dirStatuses[t.code]
		if (seed && seed !== "loading" && classicReadOk(seed)) {
			setStatus(seed)
			setPhase(phaseFor(seed, next))
		} else {
			setPhase("ready") // provisional while the per-asset status loads
		}
		fetchStatus(address, next)
			.then((st) => {
				if (gen !== statusGen.current || !classicReadOk(st)) return
				setStatus(st)
				setPhase(phaseFor(st, next))
				// Pre-build the smart-account activation for the newly picked asset.
				if (st.holderKind === "contract" && !st.sacAuthorized)
					void prepareSmartActivation(address, next)
			})
			.catch(() => {})
	}
	// Return to the asset directory WITHOUT dropping the wallet connection —
	// only the per-asset flow state resets. pick() re-reads the connected
	// wallet's status for whichever asset is chosen next, so switching assets
	// never needs a page refresh.
	const toDirectory = () => {
		statusGen.current++ // invalidate in-flight reads for the cleared selection
		setShowModal(false)
		setHash(null)
		setErrMsg("")
		setTrustlineOnly(false)
		setStatus(null)
		// Directory = no selection; a lingering deep-link/picked asset must not
		// leak into the next selection's default.
		setAsset(DEFAULT_ASSET)
		setPhase("directory")
	}
	const reset = () => {
		setHash(null)
		setErrMsg("")
		setTrustlineOnly(false)
		// Decide from the latest ledger read (refreshed after every submit), so a
		// freshly activated account lands on "already" — not the Activate CTA.
		setPhase(
			sep7Ctx
				? "sep7"
				: address
					? status
						? phaseFor(status, asset)
						: "ready"
					: "directory",
		)
	}

	// Re-read the ledger after a submit so the stored status (and therefore
	// reset()/StatusRows) reflect the new on-chain state. Best-effort: a read
	// hiccup must not fail a confirmed transaction, and an UNRELIABLE read
	// (readError with no trustline visible) must not overwrite a good status —
	// returning null tells the caller "unknown", not "not activated".
	const refreshStatus = useCallback(
		async (
			account: string,
			a: AssetConfig,
		): Promise<ActivationStatus | null> => {
			const gen = statusGen.current
			try {
				const st = await fetchStatus(account, a)
				if (gen !== statusGen.current || !classicReadOk(st)) return null
				setStatus(st)
				// Keep the directory badge for this asset in step (e.g. right after
				// a successful activation). Map-level guard (not per-key) so a badge
				// entry dropped by a failed read can still recover here.
				setDirStatuses((prev) =>
					Object.keys(prev).length > 0 ? { ...prev, [a.assetCode]: st } : prev,
				)
				return st
			} catch {
				return null
			}
		},
		[],
	)

	// ── Claimable-balance delivery ───────────────────────────────────────
	// An exchange that could not pay this address (no usable trustline) may have
	// sent a claimable balance instead. Listing balances BY CLAIMANT needs an
	// index, so this is the one read on the page that goes to Horizon rather
	// than RPC; a failure is non-fatal and simply hides the claim CTA.
	const [pending, setPending] = useState<ClaimableBalanceEntry[] | null>(null)
	const [claimHash, setClaimHash] = useState("")
	// Which flow produced the current success/error screen. Without this the
	// error heading is always the activation one ("Couldn't create trustline"),
	// which is actively misleading after a failed CLAIM.
	const [flow, setFlow] = useState<"activate" | "claim" | "sep7">(
		sep7 ? "sep7" : "activate",
	)
	// The amount claimed, for the success screen.
	const claimedAmount = useRef("")

	// One lookup for the WHOLE wallet, not per asset: the directory needs to
	// badge every tile, and Horizon returns all of them in a single response.
	useEffect(() => {
		let cancelled = false
		setPending(null)
		// Claimable balances can only name a classic account as claimant, so a
		// smart-account holder never has any.
		if (!address || isSmartAccount(address) || !NETWORK.horizonUrl) return
		findClaimableBalances({ horizonUrl: NETWORK.horizonUrl, claimant: address })
			.then((bs) => {
				if (!cancelled) setPending(bs)
			})
			.catch(() => {
				if (!cancelled) setPending([]) // treat a lookup failure as "none"
			})
		return () => {
			cancelled = true
		}
	}, [address, claimHash, hash])

	/** The balances waiting for a specific asset (code AND issuer must match). */
	const pendingFor = useCallback(
		(a: AssetConfig) =>
			(pending ?? []).filter(
				(b) => b.asset === `${a.assetCode}:${a.assetIssuer}`,
			),
		[pending],
	)
	const assetPending = pendingFor(asset)

	// How many balances wait per asset code — drives the directory tile badges,
	// so a user who lands on the directory can SEE there is something for them.
	const pendingCounts: Record<string, number> = {}
	for (const a of LIVE_ASSETS) {
		const n = pendingFor(a).length
		if (n > 0) pendingCounts[a.assetCode] = n
	}

	/**
	 * Whether the waiting balance can be collected with a SINGLE signature right
	 * now. For an open asset that holds even with no trustline — the claim
	 * transaction creates it. For an AUTH_REQUIRED asset the trustline must
	 * already be authorized: a Soroban authorize cannot share a transaction with
	 * the classic claim, so the user activates first and claims after.
	 */
	const claimable =
		assetPending.length > 0 &&
		!!status &&
		(isOpen(asset) || status.isAuthorized) &&
		!isSmartAccount(address)

	// Route into the claim screen from a resting phase only — never interrupt a
	// signing/submitting run or an error the user still needs to read.
	useEffect(() => {
		if (
			claimable &&
			(phase === "ready" || phase === "authorize" || phase === "already")
		)
			setPhase("claim")
	}, [claimable, phase])

	const claim = useCallback(async () => {
		statusGen.current++
		setFlow("claim")
		setErrMsg("")
		setTrustlineOnly(false)
		setPhase("building")
		try {
			const balance = assetPending[0]
			if (!balance) throw new Error("No claimable balance is waiting")
			claimedAmount.current = balance.amount
			// The list came from Horizon, which lags the ledger — confirm against
			// RPC that the entry is still there before asking for a signature.
			if (
				!(await getClaimableBalance({
					rpcUrl: NETWORK.rpcUrl,
					balanceId: balance.balanceId,
					allowHttp: NETWORK.allowHttp,
				}))
			)
				throw new Error("That balance has already been claimed.")
			const st = await fetchStatus(address, asset)
			const plan = planClaim({
				hasTrustline: st.hasTrustline,
				isAuthorized: st.isAuthorized,
				authRequired: !isOpen(asset),
			})
			// Refuse to build a transaction the ledger would reject: a regulated
			// asset needs its own authorize transaction first.
			if (plan.userSignatures > 1)
				throw new Error(
					`${asset.assetCode} must be authorized before it can be claimed — ` +
						"activate it first, then claim.",
				)
			const server = new rpc.Server(NETWORK.rpcUrl, {
				allowHttp: NETWORK.allowHttp,
			})
			const account = await server.getAccount(address)
			const xdr = buildClaimTx({
				networkPassphrase: NETWORK.passphrase,
				claimant: address,
				sourceSequence: account.sequenceNumber(),
				balanceId: balance.balanceId,
				config: asset,
				// The claim doubles as onboarding: one signature opens the
				// trustline and collects the balance. No sponsor here — the
				// connected wallet pays its own reserve.
				createTrustline: !st.hasTrustline,
			})
			setPhase("signing")
			const signedTxXdr = await signTx(xdr, address)
			setPhase("submitting")
			const { hash: h } = await submitAndConfirm(signedTxXdr)
			await refreshStatus(address, asset)
			setClaimHash(h)
			setHash(h)
			setPhase("success")
		} catch (e) {
			void refreshStatus(address, asset)
			setErrMsg(e instanceof Error ? e.message : String(e))
			setPhase("error")
		}
	}, [address, asset, assetPending, refreshStatus])

	const activate = useCallback(async () => {
		setFlow("activate")
		// Invalidate any pending pick()-started status read: were it to resolve
		// mid-transaction it would yank the phase out of busy, re-exposing the
		// Activate button (double submit) and the back link while signing.
		statusGen.current++
		setErrMsg("")
		setTrustlineOnly(false)
		setPhase("building")
		try {
			// A smart-account holder (e.g. Nido) cannot source a transaction —
			// a session fee payer covers the envelope (testnet friendbot) and the
			// wallet signs the smart account's authorization entry instead.
			let feePayer: Keypair | undefined
			let xdr: string
			const prep = smartPrep.current
			if (isSmartAccount(address)) {
				if (NETWORK.passphrase !== KitNetworks.TESTNET)
					throw new Error(
						"Smart-account activation is currently available on testnet only",
					)
				if (
					prep &&
					prep.holder === address &&
					prep.assetCode === asset.assetCode &&
					Date.now() < prep.expiresAt &&
					smartFee.current
				) {
					// Fast path: pre-built — the sign popup opens almost immediately.
					xdr = prep.xdr
					feePayer = smartFee.current
				} else {
					// Slow path (prep missed/expired): the popup may be blocked by the
					// browser; the wallet module's error tells the user to allow popups.
					await prepareSmartActivation(address, asset)
					if (!smartPrep.current || !smartFee.current)
						throw new Error("Could not fund the fee account — try again")
					xdr = smartPrep.current.xdr
					feePayer = smartFee.current
				}
				smartPrep.current = null // single-use: seq number is consumed
			} else {
				xdr = await buildOnboardTx({
					rpcUrl: NETWORK.rpcUrl,
					networkPassphrase: NETWORK.passphrase,
					holder: address,
					config: asset,
					allowHttp: NETWORK.allowHttp,
				})
			}
			setPhase("signing")
			// For a smart account the wallet returns the tx with the holder's auth
			// entry passkey-signed; the session fee payer then signs the envelope.
			let signedTxXdr = await signTx(xdr, address)
			if (feePayer) {
				const tx = TransactionBuilder.fromXDR(signedTxXdr, NETWORK.passphrase)
				tx.sign(feePayer)
				signedTxXdr = tx.toXDR()
			}
			setPhase("submitting")
			const { hash, returnValue } = await submitAndConfirm(signedTxXdr)
			// The router reports the truthful outcome: Authorized, or
			// TrustlineOnly (trustline kept, no one-step authorizer). On an
			// unknown/undecodable return value, fall back to the asset's static
			// capability so we never render the stronger "authorized" claim for an
			// asset that may only be trustline-only.
			const outcome = decodeOnboardStatus(returnValue)
			// For a smart account, TrustlineOnly means NOTHING changed on-chain
			// (CAP-73 trust() no-ops for contracts and no authorizer ran) — that is
			// a truthful failure, not a success.
			if (isSmartAccount(address) && outcome === "TrustlineOnly")
				throw new Error(
					`${asset.assetCode} has no on-chain authorizer — smart accounts ` +
						"cannot be activated for it yet.",
				)
			setTrustlineOnly(outcome ? outcome === "TrustlineOnly" : !isOpen(asset))
			await refreshStatus(address, asset)
			setHash(hash)
			setPhase("success")
		} catch (e) {
			// Refresh in the background: a timed-out tx may still land, and the
			// error screen's Try-again/Cancel route from the stored status.
			void refreshStatus(address, asset)
			// Re-prep so a retry click reaches the popup fast again.
			if (isSmartAccount(address)) void prepareSmartActivation(address, asset)
			setErrMsg(e instanceof Error ? e.message : String(e))
			setPhase("error")
		}
	}, [address, asset, refreshStatus, prepareSmartActivation])

	// Direct authorize-only call for an existing unauthorized trustline: the
	// asset's Authorizer contract (its SAC admin) runs authorize_trustline →
	// SAC set_authorized. The connected wallet only pays the fee — authorization
	// authority comes from the Authorizer being the SAC admin.
	const authorize = useCallback(async () => {
		setFlow("activate")
		// Same stale-read invalidation as activate() — see the comment there.
		statusGen.current++
		setErrMsg("")
		setTrustlineOnly(false)
		setPhase("building")
		try {
			const xdr = await buildAuthorizeTx({
				rpcUrl: NETWORK.rpcUrl,
				networkPassphrase: NETWORK.passphrase,
				source: address,
				account: address,
				config: asset,
				allowHttp: NETWORK.allowHttp,
			})
			setPhase("signing")
			const signedTxXdr = await signTx(xdr, address)
			setPhase("submitting")
			const { hash } = await submitAndConfirm(signedTxXdr)
			// Truthful success copy: only claim "authorized" if the ledger agrees.
			const st = await refreshStatus(address, asset)
			setTrustlineOnly(st ? !st.isAuthorized : false)
			setHash(hash)
			setPhase("success")
		} catch (e) {
			// Refresh in the background: a timed-out tx may still land, and the
			// error screen's Try-again/Cancel route from the stored status.
			void refreshStatus(address, asset)
			setErrMsg(e instanceof Error ? e.message : String(e))
			setPhase("error")
		}
	}, [address, asset, refreshStatus])

	// Sign the SEP-7 request with the connected wallet and deliver it the way
	// the request asked: to its `callback` (the sender submits — and, for a
	// smart-account holder, countersigns as fee source first) or straight to
	// the network.
	const signSep7 = useCallback(async () => {
		if (!sep7Ctx) return
		const { req, summary, signer } = sep7Ctx
		setFlow("sep7")
		statusGen.current++
		setErrMsg("")
		setTrustlineOnly(false)
		setSep7Returned(false)
		try {
			if (address !== signer)
				throw new Error(
					`This request is for ${short(signer, 6, 6)}, but the connected ` +
						`wallet is ${short(address, 6, 6)}.`,
				)
			const others = summary.signers.filter((s) => s !== signer)
			if (others.length > 0 && summary.signatures === 0 && !req.callback)
				throw new Error(
					"This transaction also needs a signature from " +
						`${others.map((s) => short(s, 6, 6)).join(", ")}, and the ` +
						"request names no callback to return it through. Ask the " +
						"sender to countersign first, or to set a callback.",
				)
			setPhase("signing")
			const signed = await signTx(req.xdr, address)
			setPhase("submitting")
			let h: string | null = null
			if (req.callback) {
				const { body } = await postSep7Callback(req.callback, signed)
				const b = body as { txHash?: unknown; hash?: unknown } | null
				const got =
					b && typeof b === "object" ? (b.txHash ?? b.hash) : undefined
				h = typeof got === "string" ? got : null
				setSep7Returned(true)
			} else {
				const res = await submitAndConfirm(signed)
				h = res.hash
				if (summary.onboard) {
					const outcome = decodeOnboardStatus(res.returnValue)
					setTrustlineOnly(
						outcome
							? outcome === "TrustlineOnly"
							: sep7Ctx.asset
								? !isOpen(sep7Ctx.asset)
								: false,
					)
				}
			}
			if (sep7Ctx.asset) await refreshStatus(address, sep7Ctx.asset)
			setHash(h)
			setPhase("success")
		} catch (e) {
			if (sep7Ctx.asset) void refreshStatus(address, sep7Ctx.asset)
			setErrMsg(e instanceof Error ? e.message : String(e))
			setPhase("error")
		}
	}, [sep7Ctx, address, refreshStatus])

	const busy =
		phase === "building" || phase === "signing" || phase === "submitting"

	// Disconnect and reopen the wallet picker — the only way to switch accounts
	// for wallets that cache the selection (e.g. Nido picks the account at
	// CONNECT time; the sign popup is bound to it — see theahaco/nido#89).
	// Keeps the selected asset; the new connection re-reads its status.
	const switchWallet = () => {
		if (busy) return // never abandon a transaction mid-flight
		statusGen.current++
		dirGen.current++ // the badges belong to the outgoing wallet
		isConnected.current = false
		smartPrep.current = null
		void StellarWalletsKit.disconnect().catch(() => {})
		setAddress("")
		setStatus(null)
		setDirStatuses({})
		setHash(null)
		setErrMsg("")
		setTrustlineOnly(false)
		setPhase(phase === "directory" ? "directory" : "idle")
		setShowModal(true)
	}

	let body: React.ReactNode = null
	if (phase === "directory") {
		body = (
			<Directory
				onPick={pick}
				statuses={Object.keys(dirStatuses).length > 0 ? dirStatuses : undefined}
				pendingCounts={pendingCounts}
			/>
		)
	} else if (phase === "sep7" && sep7Ctx) {
		const { req, summary, signer } = sep7Ctx
		const others = summary.signers.filter((s) => s !== signer)
		const connectedHere = !!address && isConnected.current
		const mismatch = connectedHere && address !== signer
		const alreadyDone =
			!!sep7Ctx.asset && !!status && isAuthorizedStatus(status)
		const provenance =
			sep7Verify.state === "verified" ? (
				<Pill accent>Verified</Pill>
			) : sep7Verify.state === "forged" ? (
				<Pill tone="err">Bad signature</Pill>
			) : sep7Verify.state === "checking" ? (
				<Pill>
					<Spinner size={10} /> Checking
				</Pill>
			) : sep7Verify.state === "unverified" ? (
				<Pill tone="warn">Unverified</Pill>
			) : (
				<Pill tone="warn">Unsigned</Pill>
			)
		const note: React.CSSProperties = {
			fontFamily: AL.disp,
			fontSize: 12.5,
			lineHeight: 1.5,
			color: AL.mut,
			margin: "12px 0 0",
		}
		body = (
			<div className="al-fade">
				{sep7Ctx.asset && (
					<AssetRow
						asset={sep7Ctx.asset}
						status={<Pill accent>Request</Pill>}
					/>
				)}
				<div
					style={{
						background: "rgba(46,111,168,0.08)",
						border: "1px solid rgba(46,111,168,0.28)",
						borderRadius: 12,
						padding: "11px 13px",
						marginBottom: 14,
						fontFamily: AL.disp,
						fontSize: 12.5,
						lineHeight: 1.45,
						color: AL.mut,
					}}
				>
					<div
						style={{
							display: "flex",
							justifyContent: "space-between",
							alignItems: "center",
							gap: 10,
						}}
					>
						<span>
							From{" "}
							<b style={{ color: AL.ink }}>
								{req.originDomain ?? "an unknown sender"}
							</b>
						</span>
						{provenance}
					</div>
					{req.msg && (
						<div style={{ marginTop: 6, color: AL.ink, fontStyle: "italic" }}>
							“{req.msg}”
						</div>
					)}
					{sep7Verify.state === "unverified" && (
						<div style={{ marginTop: 6 }}>
							{sep7Verify.reason}. Check what you are signing below.
						</div>
					)}
					{sep7Verify.state === "forged" && (
						<div style={{ marginTop: 6, color: "#B5532E" }}>
							The signature does not match {req.originDomain}’s published key.
							Signing is disabled.
						</div>
					)}
					{sep7Verify.state === "unsigned" && (
						<div style={{ marginTop: 6 }}>
							The request names no origin domain, so its sender cannot be
							verified. Check what you are signing below.
						</div>
					)}
				</div>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV
						k="You sign"
						v={
							sep7Ctx.asset
								? `Activate ${sep7Ctx.asset.assetCode}${
										summary.ops.some(
											(o) => o.type === "beginSponsoringFutureReserves",
										)
											? " (reserve sponsored)"
											: ""
									}`
								: summary.onboard
									? "Activate an asset"
									: `${summary.ops.length} operation${
											summary.ops.length === 1 ? "" : "s"
										}`
						}
						accent={AL.emeraldBright}
						mono={false}
					/>
					<KV
						k="For account"
						v={short(signer, 6, 6)}
						accent={mismatch ? "#B5532E" : undefined}
					/>
					<KV
						k="Network"
						v={IS_PUBLIC ? "Stellar · Mainnet" : "Stellar · Testnet"}
						mono={false}
					/>
					<KV k="Max fee" v={`${stroopsToXlm(summary.fee)} XLM`} />
					{others.length > 0 && (
						<KV
							k="Also signed by"
							v={others.map((o) => short(o, 4, 4)).join(", ")}
						/>
					)}
					<KV
						k="Then"
						v={
							req.callback
								? "Returned to the sender"
								: "Submitted to the network"
						}
						mono={false}
					/>
				</div>
				<details
					style={{
						margin: "12px 0 0",
						fontFamily: AL.mono,
						fontSize: 11,
						color: AL.mut,
					}}
				>
					<summary
						style={{ cursor: "pointer", fontFamily: AL.disp, fontSize: 12.5 }}
					>
						Transaction detail
					</summary>
					<ul
						style={{
							margin: "8px 0 0",
							paddingLeft: 16,
							lineHeight: 1.6,
							wordBreak: "break-all",
						}}
					>
						{summary.ops.map((op, i) => (
							<li key={i}>
								{op.type}
								{op.contract
									? ` · ${short(op.contract, 6, 6)}.${op.function}(${(
											op.args ?? []
										)
											.map((a) =>
												typeof a === "string" && a.length > 20
													? short(a, 6, 6)
													: String(a),
											)
											.join(", ")})`
									: ""}
								{op.detail ? ` · ${op.detail}` : ""}
							</li>
						))}
					</ul>
					<div
						style={{
							marginTop: 8,
							wordBreak: "break-all",
							maxHeight: 96,
							overflowY: "auto",
							padding: 8,
							background: AL.paper,
							borderRadius: 8,
						}}
					>
						{req.uri}
					</div>
				</details>
				{alreadyDone && (
					<p style={note}>
						This account is already authorized for {sep7Ctx.asset?.assetCode}.
						Signing again is harmless but changes nothing.
					</p>
				)}
				{mismatch && (
					<p style={{ ...note, color: "#B5532E" }}>
						This request is for {short(signer, 6, 6)}, but the connected wallet
						is {short(address, 6, 6)}. Switch to the wallet that holds that
						account.
					</p>
				)}
				<div style={{ display: "flex", gap: 10, marginTop: 16 }}>
					<Ghost full onClick={toDirectory}>
						Decline
					</Ghost>
					{!connectedHere ? (
						<Primary
							onClick={() =>
								e2eSigner() ? connect("e2e") : setShowModal(true)
							}
						>
							Connect wallet to sign
						</Primary>
					) : mismatch ? (
						<Primary onClick={switchWallet}>Switch wallet</Primary>
					) : (
						<Primary
							onClick={signSep7}
							disabled={sep7Verify.state === "forged"}
						>
							Sign · 1 signature
						</Primary>
					)}
				</div>
				{canRegisterHandler() && (
					<button
						className="al-link"
						onClick={registerSep7Handler}
						style={{
							background: "none",
							border: "none",
							cursor: "pointer",
							padding: 0,
							marginTop: 14,
							fontFamily: AL.disp,
							fontSize: 12,
							color: AL.mut,
						}}
					>
						Open future web+stellar: links here
					</button>
				)}
			</div>
		)
	} else if (phase === "idle") {
		body = (
			<div className="al-fade">
				<AssetRow
					asset={asset}
					status={<Pill accent>{statusPill(asset)}</Pill>}
				/>
				<Divider />
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 14,
						lineHeight: 1.55,
						color: AL.mut,
						margin: "2px 0 18px",
					}}
				>
					{isOpen(asset) ? (
						<>
							Connect a wallet to create your {asset.assetCode} trustline in a
							single signature.
						</>
					) : (
						<>
							Connect a wallet to create <b style={{ color: AL.ink }}>and</b>{" "}
							authorize your {asset.assetCode} trustline in a single signature.
						</>
					)}
				</p>
				{ROUTER_MISSING && (
					<p
						style={{
							fontFamily: AL.disp,
							fontSize: 12.5,
							lineHeight: 1.5,
							color: AL.mut,
							margin: "0 0 10px",
						}}
					>
						Activation is not yet configured for this network.
					</p>
				)}
				{ROUTER_MISSING ? (
					<Primary disabled>Activation unavailable</Primary>
				) : (
					<Primary
						onClick={() => (e2eSigner() ? connect("e2e") : setShowModal(true))}
					>
						<svg
							width="15"
							height="15"
							viewBox="0 0 16 16"
							fill="none"
							stroke="#FFFFFF"
							strokeWidth="1.7"
						>
							<rect x="2.5" y="4.5" width="11" height="8" rx="2" />
							<path d="M2.5 7h11" />
						</svg>
						Connect wallet
					</Primary>
				)}
				<div
					style={{
						display: "flex",
						justifyContent: "center",
						gap: 16,
						marginTop: 16,
						fontFamily: AL.mono,
						fontSize: 10.5,
						letterSpacing: "0.04em",
						textTransform: "uppercase",
						color: AL.mut2,
					}}
				>
					<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<Dot color={AL.emerald} size={5} /> Non-custodial
					</span>
					<span style={{ display: "flex", alignItems: "center", gap: 6 }}>
						<Dot color={AL.emerald} size={5} /> CAP-73
					</span>
				</div>
			</div>
		)
	} else if (phase === "preview") {
		body = (
			<div className="al-fade">
				<div
					style={{
						display: "flex",
						gap: 10,
						alignItems: "flex-start",
						background: "rgba(46,111,168,0.08)",
						border: "1px solid rgba(46,111,168,0.28)",
						borderRadius: 12,
						padding: "11px 13px",
						marginBottom: 16,
					}}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="#2E6FA8"
						strokeWidth="1.6"
						style={{ flexShrink: 0, marginTop: 1 }}
					>
						<circle cx="8" cy="8" r="6.5" />
						<path d="M8 7.4v3.2M8 5.2v.2" />
					</svg>
					<div
						style={{
							fontFamily: AL.disp,
							fontSize: 12.5,
							lineHeight: 1.45,
							color: AL.mut,
						}}
					>
						Read-only preview for{" "}
						<span style={{ fontFamily: AL.mono, color: AL.ink }}>
							{short(address, 6, 6)}
						</span>
						. Connect this account to activate.
					</div>
				</div>
				<AssetRow
					asset={asset}
					status={
						<Pill tone="mut" accent={status?.hasTrustline}>
							{status?.hasTrustline ? "Trustline" : "Not yet"}
						</Pill>
					}
				/>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<StatusRows st={status} asset={asset} />
				</div>
				<div style={{ marginTop: 18 }}>
					<Primary onClick={() => setShowModal(true)}>
						Connect to activate
					</Primary>
				</div>
			</div>
		)
	} else if (phase === "ready") {
		body = (
			<div className="al-fade">
				<AssetRow
					asset={asset}
					status={<Pill accent>{statusPill(asset)}</Pill>}
				/>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV k="Your account" v={short(address)} />
					<KV k="Network" v={asset.networkLabel} mono={false} />
					<KV
						k="You sign"
						v="1 transaction"
						accent={AL.emeraldBright}
						mono={false}
					/>
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 12.5,
						lineHeight: 1.5,
						color: AL.mut,
						margin: "15px 0 16px",
					}}
				>
					{isSmartAccount(address) ? (
						<>
							One passkey approval authorizes your smart account for{" "}
							{asset.assetCode} — no trustline, no reserve; a throwaway account
							pays the network fee for you.
						</>
					) : isOpen(asset) ? (
						<>
							One signature runs{" "}
							<span style={{ fontFamily: AL.mono, color: AL.ink }}>
								trust()
							</span>{" "}
							(CAP-73) — your {asset.assetCode} trustline is created and usable
							immediately, with no separate authorize step.
						</>
					) : (
						<>
							One signature runs{" "}
							<span style={{ fontFamily: AL.mono, color: AL.ink }}>
								trust()
							</span>{" "}
							(CAP-73) then authorizes the line — no separate “create a
							trustline” step.
						</>
					)}
				</p>
				{ROUTER_MISSING && (
					<p
						style={{
							fontFamily: AL.disp,
							fontSize: 12.5,
							lineHeight: 1.5,
							color: AL.mut,
							margin: "0 0 10px",
						}}
					>
						Activation is not yet configured for this network.
					</p>
				)}
				{ROUTER_MISSING ? (
					<Primary disabled>Activation unavailable</Primary>
				) : (
					<Primary onClick={activate}>
						<svg
							width="15"
							height="15"
							viewBox="0 0 16 16"
							fill="none"
							stroke="#FFFFFF"
							strokeWidth="1.9"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M3.5 8.5l3 3 6-7" />
						</svg>
						Activate {asset.assetCode} · 1 signature
					</Primary>
				)}
				<div
					style={{
						textAlign: "center",
						fontFamily: AL.mono,
						fontSize: 10.5,
						color: AL.mut2,
						marginTop: 12,
					}}
				>
					Only the network fee is spent.
				</div>
			</div>
		)
	} else if (phase === "authorize") {
		body = (
			<div className="al-fade">
				<AssetRow asset={asset} status={<Pill>Trustline only</Pill>} />
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV k="Your account" v={short(address)} />
					<StatusRows st={status} asset={asset} />
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 12.5,
						lineHeight: 1.5,
						color: AL.mut,
						margin: "15px 0 16px",
					}}
				>
					Your {asset.assetCode} trustline exists but isn’t authorized yet. One
					signature calls the issuer’s on-chain authorizer (
					<span style={{ fontFamily: AL.mono, color: AL.ink }}>
						authorize_trustline
					</span>
					, the asset’s SAC admin) to authorize it — no new trustline is
					created.
				</p>
				<Primary onClick={authorize}>
					<svg
						width="15"
						height="15"
						viewBox="0 0 16 16"
						fill="none"
						stroke="#FFFFFF"
						strokeWidth="1.9"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M3.5 8.5l3 3 6-7" />
					</svg>
					Authorize {asset.assetCode} · 1 signature
				</Primary>
				<div
					style={{
						textAlign: "center",
						fontFamily: AL.mono,
						fontSize: 10.5,
						color: AL.mut2,
						marginTop: 12,
					}}
				>
					Only the network fee is spent.
				</div>
			</div>
		)
	} else if (phase === "claim") {
		const balance = assetPending[0]
		const needsTrustline = !status?.hasTrustline
		body = (
			<div className="al-fade">
				<AssetRow asset={asset} status={<Pill accent>Waiting for you</Pill>} />
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV k="Your account" v={short(address)} />
					<KV
						k="Amount waiting"
						v={`${balance?.amount ?? "—"} ${asset.assetCode}`}
					/>
					<StatusRows st={status} asset={asset} />
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 12.5,
						lineHeight: 1.5,
						color: AL.mut,
						margin: "15px 0 16px",
					}}
				>
					{needsTrustline ? (
						<>
							Someone sent you {asset.assetCode} as a claimable balance because
							your account couldn’t receive it yet. One signature opens your{" "}
							{asset.assetCode} trustline <em>and</em> collects the balance in
							the same transaction.
						</>
					) : (
						<>
							Someone sent you {asset.assetCode} as a claimable balance. Your
							trustline is ready — one signature collects it.
						</>
					)}
				</p>
				<Primary onClick={claim}>
					<svg
						width="15"
						height="15"
						viewBox="0 0 16 16"
						fill="none"
						stroke="#FFFFFF"
						strokeWidth="1.9"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<path d="M8 2.5v8m0 0l3-3m-3 3l-3-3M3 13h10" />
					</svg>
					Claim {balance?.amount ?? ""} {asset.assetCode} · 1 signature
				</Primary>
				{assetPending.length > 1 && (
					<div
						style={{
							textAlign: "center",
							fontFamily: AL.mono,
							fontSize: 10.5,
							color: AL.mut2,
							marginTop: 12,
						}}
					>
						{assetPending.length} balances waiting — claim them one at a time.
					</div>
				)}
				<div
					style={{
						textAlign: "center",
						fontFamily: AL.mono,
						fontSize: 10.5,
						color: AL.mut2,
						marginTop: 12,
					}}
				>
					{needsTrustline
						? "The network fee and the 0.5 XLM trustline reserve are spent."
						: "Only the network fee is spent."}
				</div>
			</div>
		)
	} else if (busy) {
		const labels: Record<string, string> = {
			building: "Preparing your transaction…",
			signing: "Confirm in your wallet…",
			submitting: "Submitting to the network…",
		}
		body = (
			<div className="al-fade">
				<AssetRow asset={asset} status={<Pill>Pending</Pill>} />
				<Progress state={phase} />
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 12,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<Spinner color={AL.emerald} size={20} />
					<div
						style={{
							fontFamily: AL.disp,
							fontSize: 14.5,
							fontWeight: 500,
							color: AL.ink,
						}}
					>
						{labels[phase]}
					</div>
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 12,
						color: AL.mut2,
						margin: "14px 0 16px",
						minHeight: 16,
					}}
				>
					{phase === "signing"
						? "Approve the transaction in your wallet to continue."
						: phase === "submitting"
							? "Waiting for network confirmation."
							: "Building the one-signature onboarding transaction."}
				</p>
				<Primary disabled>
					<Spinner color={AL.mut} size={15} track="rgba(40,30,15,0.12)" />{" "}
					{phase === "signing" ? "Awaiting signature" : "Working…"}
				</Primary>
			</div>
		)
	} else if (phase === "success") {
		body = (
			<div className="al-fade">
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						alignItems: "center",
						textAlign: "center",
						paddingTop: 4,
					}}
				>
					<div
						style={{
							width: 62,
							height: 62,
							borderRadius: 62,
							background: AL.emeraldSoft,
							border: `1px solid ${AL.emeraldLine}`,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							marginBottom: 16,
							animation: "alpop .45s cubic-bezier(.2,.8,.3,1.2) both",
						}}
					>
						<svg width="30" height="30" viewBox="0 0 100 100" fill="none">
							<path
								className="al-check-c"
								d="M22 52 L42 72 L84 24"
								stroke={AL.emeraldBright}
								strokeWidth="12"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</div>
					<div
						style={{
							fontFamily: AL.disp,
							fontWeight: 600,
							fontSize: 22,
							color: AL.ink,
							letterSpacing: "-0.02em",
						}}
					>
						{flow === "claim"
							? `${claimedAmount.current} ${asset.assetCode} claimed`
							: flow === "sep7" && !sep7Ctx?.asset
								? "Request signed"
								: isSmartAccount(address)
									? `${asset.assetCode} activated for your smart account`
									: trustlineOnly
										? `${asset.assetCode} trustline created`
										: `${asset.assetCode} trustline authorized`}
					</div>
					<div
						style={{
							fontFamily: AL.disp,
							fontSize: 14,
							color: AL.mut,
							marginTop: 6,
						}}
					>
						{flow === "claim" ? (
							<>
								The balance is in your wallet, and your {asset.assetCode}{" "}
								trustline is open.
							</>
						) : sep7Returned ? (
							<>
								Your signature went back to{" "}
								{sep7Ctx?.req.originDomain ?? "the sender"}, which submitted the
								transaction.
							</>
						) : trustlineOnly ? (
							<>
								Trustline created — the issuer authorizes holders off-platform.
							</>
						) : (
							<>You’re ready to receive {asset.assetCode}.</>
						)}
					</div>
				</div>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "16px 0",
						margin: "18px 0 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV
						k="Status"
						v={
							flow === "claim"
								? "● Claimed"
								: flow === "sep7" && !sep7Ctx?.asset
									? "● Signed"
									: trustlineOnly
										? "● Trustline created"
										: "● Authorized"
						}
						accent={AL.emeraldBright}
						mono={false}
					/>
					<KV k="Account" v={short(address)} />
					{hash && <KV k="Transaction" v={short(hash)} />}
				</div>
				<div style={{ display: "flex", gap: 10, marginTop: 16 }}>
					{hash && (
						<Ghost full href={txUrl(hash)}>
							View on Explorer
						</Ghost>
					)}
					<Primary onClick={reset}>Done</Primary>
				</div>
			</div>
		)
	} else if (phase === "already") {
		body = (
			<div className="al-fade">
				<AssetRow
					asset={asset}
					status={
						<Pill accent>
							<svg
								width="10"
								height="10"
								viewBox="0 0 16 16"
								fill="none"
								stroke={AL.emeraldBright}
								strokeWidth="2.4"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M3.5 8.5l3 3 6-7" />
							</svg>{" "}
							Authorized
						</Pill>
					}
				/>
				<div
					style={{
						display: "flex",
						flexDirection: "column",
						gap: 11,
						padding: "15px 0",
						borderTop: `1px solid ${AL.line}`,
						borderBottom: `1px solid ${AL.line}`,
					}}
				>
					<KV k="Your account" v={short(address)} />
					<StatusRows st={status} asset={asset} />
				</div>
				<p
					style={{
						fontFamily: AL.disp,
						fontSize: 13,
						lineHeight: 1.5,
						color: AL.mut,
						margin: "15px 0 16px",
					}}
				>
					You’re all set — this account can already hold and receive{" "}
					{asset.assetCode}.
				</p>
				<Ghost full href={acctUrl(address)}>
					View on Explorer
				</Ghost>
			</div>
		)
	} else if (phase === "error") {
		body = (
			<div className="al-fade">
				<AssetRow asset={asset} status={<Pill tone="err">Failed</Pill>} />
				<div
					style={{
						display: "flex",
						gap: 11,
						alignItems: "flex-start",
						background: "rgba(181,83,46,0.08)",
						border: "1px solid rgba(181,83,46,0.25)",
						borderRadius: 12,
						padding: "13px 14px",
						margin: "4px 0 16px",
					}}
				>
					<svg
						width="17"
						height="17"
						viewBox="0 0 16 16"
						fill="none"
						stroke="#B5532E"
						strokeWidth="1.6"
						style={{ flexShrink: 0, marginTop: 1 }}
					>
						<circle cx="8" cy="8" r="6.5" />
						<path d="M8 5v3.6M8 10.8v.2" />
					</svg>
					<div>
						<div
							style={{
								fontFamily: AL.disp,
								fontWeight: 600,
								fontSize: 14,
								color: AL.ink,
							}}
						>
							{flow === "claim"
								? "Couldn’t claim your balance"
								: flow === "sep7"
									? "Couldn’t complete the request"
									: errorHeading(asset)}
						</div>
						<div
							style={{
								fontFamily: AL.disp,
								fontSize: 12.5,
								lineHeight: 1.45,
								color: AL.mut,
								marginTop: 3,
							}}
						>
							{errMsg ||
								"The transaction was rejected. Nothing was submitted to the network."}
						</div>
						{/* OZ smart accounts: a policy-less rule with N passkeys is
						    N-of-N — a single-passkey wallet ceremony can then never
						    authorize. Decode the raw HostError for the user. */}
						{isSmartAccount(address) &&
							/UnvalidatedContext|Contract, #3002/.test(errMsg) && (
								<div
									style={{
										fontFamily: AL.disp,
										fontSize: 12.5,
										lineHeight: 1.45,
										color: AL.mut,
										marginTop: 8,
									}}
								>
									Your smart account rejected the single-passkey signature
									(error #3002). This usually means its default rule lists
									several passkeys without a threshold policy, so ALL of them
									must sign. In your Nido wallet&apos;s security settings,
									remove the extra passkey or add a 1-of-N policy to the default
									rule, then retry.
								</div>
							)}
					</div>
				</div>
				<div style={{ display: "flex", gap: 10 }}>
					<Ghost full onClick={reset}>
						Cancel
					</Ghost>
					{/* Retry the action that matches the state: a failed CONNECT (no
					    address — the pairing was cleared) re-opens the wallet picker;
					    an existing unauthorized trustline retries the direct authorize
					    call; everything else retries the activation. */}
					{!(sep7 && !sep7Ctx) && (
						<Primary
							onClick={
								!address
									? () => setShowModal(true)
									: flow === "sep7"
										? signSep7
										: status &&
											  status.hasTrustline &&
											  !status.isAuthorized &&
											  canAuthorize(asset)
											? authorize
											: activate
							}
						>
							Try again
						</Primary>
					)}
				</div>
			</div>
		)
	}

	// The wallet stays connected across "‹ All assets" — the header pill must
	// keep showing it in the directory, not pretend the user disconnected.
	const connected = !!address && isConnected.current
	const head = sep7Ctx
		? {
				t: "Sign a request",
				s: sep7Ctx.asset
					? `${sep7Ctx.req.originDomain ?? "A third party"} asks you to activate ${sep7Ctx.asset.assetCode} — one signature.`
					: `${sep7Ctx.req.originDomain ?? "A third party"} asks for your signature.`,
			}
		: phase === "directory"
			? {
					t: "Activate a Stellar asset",
					s: `One signature to hold any supported asset — ${
						LIVE_ASSETS.length === 1
							? `${LIVE_ASSETS[0]?.assetCode} is`
							: `${LIVE_ASSETS.length} are`
					} live now, more onboarding soon.`,
				}
			: {
					t: `Activate ${asset.assetCode}`,
					s: `Receive ${asset.name} in one signature.`,
				}

	return (
		<div
			style={{
				position: "relative",
				width: "100%",
				minHeight: "100%",
				background: AL.paper,
				overflow: "hidden",
				display: "flex",
				flexDirection: "column",
			}}
		>
			<div
				style={{
					position: "absolute",
					top: -180,
					right: -140,
					width: 520,
					height: 520,
					borderRadius: 520,
					background:
						"radial-gradient(circle, rgba(22,115,74,0.05), transparent 62%)",
					pointerEvents: "none",
				}}
			/>
			<div
				style={{
					position: "relative",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					padding: "20px 26px",
					flexShrink: 0,
				}}
			>
				<a
					href="./index.html"
					style={{
						display: "flex",
						alignItems: "center",
						gap: 10,
						textDecoration: "none",
					}}
				>
					<svg width="27" height="27" viewBox="0 0 100 100" fill="none">
						<rect
							x="14"
							y="33"
							width="72"
							height="34"
							rx="17"
							stroke={AL.emerald}
							strokeWidth="6.5"
						/>
						<circle cx="67" cy="50" r="12.5" fill={AL.emerald} />
					</svg>
					<span
						style={{
							fontFamily: AL.disp,
							fontWeight: 700,
							fontSize: 19,
							letterSpacing: "-0.03em",
							color: AL.ink,
						}}
					>
						Authline
					</span>
				</a>
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 16,
						fontFamily: AL.disp,
						fontSize: 13.5,
						color: AL.mut,
					}}
				>
					<a
						className="al-link"
						href={REPO_URL}
						target="_blank"
						rel="noopener noreferrer"
						style={{ color: AL.mut, textDecoration: "none" }}
					>
						Docs
					</a>
					{connected ? (
						<button
							className="al-cta"
							onClick={switchWallet}
							disabled={busy}
							aria-label="Switch wallet"
							title="Switch wallet"
							style={{
								background: "none",
								border: "none",
								padding: 0,
								cursor: busy ? "default" : "pointer",
							}}
						>
							<Pill>
								<Dot color={AL.emeraldBright} /> {short(address)} ⇄
							</Pill>
						</button>
					) : (
						<>
							<button
								className="al-cta"
								onClick={() => setShowModal(true)}
								style={{
									background: AL.emerald,
									color: "#FFFFFF",
									border: "none",
									cursor: "pointer",
									fontFamily: AL.disp,
									fontWeight: 600,
									fontSize: 13,
									padding: "7px 14px",
									borderRadius: 999,
								}}
							>
								Connect
							</button>
							<Pill>
								<Dot color={AL.emerald} /> {IS_PUBLIC ? "Mainnet" : "Testnet"}
							</Pill>
						</>
					)}
				</div>
			</div>
			<div
				style={{
					position: "relative",
					flex: 1,
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					padding: "8px 24px 40px",
				}}
			>
				<div style={{ textAlign: "center", marginBottom: 22, maxWidth: 380 }}>
					<h1
						style={{
							margin: 0,
							fontFamily: AL.disp,
							fontWeight: 600,
							fontSize: 27,
							letterSpacing: "-0.025em",
							color: AL.ink,
						}}
					>
						{head.t}
					</h1>
					<p
						style={{
							margin: "8px 0 0",
							fontFamily: AL.disp,
							fontSize: 14.5,
							color: AL.mut,
							lineHeight: 1.5,
						}}
					>
						{head.s}
					</p>
				</div>
				<Card>
					{/* Always reachable way back to the asset list (wallet connection
					    kept) — except mid-flight, where abandoning a signing/submitting
					    transaction would mislead. */}
					{phase !== "directory" && phase !== "sep7" && !busy && (
						<button
							className="al-link"
							onClick={toDirectory}
							style={{
								background: "none",
								border: "none",
								cursor: "pointer",
								padding: 0,
								marginBottom: 12,
								fontFamily: AL.disp,
								fontSize: 12.5,
								color: AL.mut,
							}}
						>
							‹ All assets
						</button>
					)}
					{body}
				</Card>
				<div
					style={{
						fontFamily: AL.mono,
						fontSize: 11,
						color: AL.mut2,
						marginTop: 20,
						textAlign: "center",
						letterSpacing: "0.03em",
					}}
				>
					Powered by Authline · one signature via CAP-73
				</div>
			</div>
			{showModal && (
				<WalletModal
					onPick={connect}
					onClose={() => setShowModal(false)}
					available={available}
				/>
			)}
		</div>
	)
}
