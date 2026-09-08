/**
 * Reference THIRD-PARTY withdrawal screen — the integrator end of the SEP-7
 * handoff, as an exchange would run it.
 *
 * This is deliberately NOT the Authline dApp. It stands in for an exchange or
 * broker that has a customer's Stellar address and wants to pay them in a
 * regulated (AUTH_REQUIRED) asset. Such an integrator holds no key of the
 * customer's and has no wallet integration. Its BACKEND — here, the Authline
 * relayer — builds the onboarding transaction, signs a SEP-7 request with the
 * key published in its stellar.toml, and the customer's OWN wallet signs the
 * transaction. The signed envelope comes back to the backend through the SEP-7
 * `callback`, which submits it and learns the result directly.
 *
 * The page itself only renders: it never sees a secret and never builds a
 * transaction. Everything it shows comes from `POST /v1/sep7/request`.
 */
import { StrKey } from "@stellar/stellar-sdk"
import { getActivationStatus, type ActivationStatus } from "@theahaco/authline"
import QRCode from "qrcode"
import { useCallback, useEffect, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
	ASSET,
	LIVE_ASSETS,
	NETWORK,
	NETWORK_LABEL,
	RELAYER_URL,
} from "./config"
import "./withdraw.css"

/** QR capacity is finite; a prepared Soroban envelope can exceed it. */
const QR_MAX_BYTES = 2900

/** Albedo's SEP-7 entry point: a web wallet, no install, handles testnet. */
const albedoUrl = (uri: string) =>
	`https://albedo.link/web-stellar-handler?sep0007link=${encodeURIComponent(uri)}`

const explorer = NETWORK.passphrase.includes("Public")
	? "https://stellar.expert/explorer/public"
	: "https://stellar.expert/explorer/testnet"
const expertTx = (h: string) => `${explorer}/tx/${h}`
const expertAccount = (a: string) =>
	`${explorer}/${StrKey.isValidContract(a) ? "contract" : "account"}/${a}`

const isReady = (st: ActivationStatus) =>
	st.holderKind === "contract" ? !!st.sacAuthorized : st.isAuthorized

/** What `POST /v1/sep7/request` answers. */
interface Sep7RequestResponse {
	account: string
	asset: string
	/** ready · A (authorized on your behalf, done) · B (sponsored) · C (router) */
	case?: "ready" | "A" | "B" | "C"
	sponsored?: boolean
	createAccount?: boolean
	authorized?: boolean
	txHash?: string
	alreadyAuthorized: boolean
	sep7Uri?: string
	handlerUrl?: string
	callback?: string
	signed?: boolean
	originDomain?: string | null
	expiresAt?: string
	error?: string
	detail?: string
}

type Phase =
	| { t: "form" }
	| { t: "building" }
	| { t: "ready-already" }
	| {
			t: "handoff"
			kase: "B" | "C"
			createAccount: boolean
			uri: string
			handlerUrl?: string
			qr: string | null
			signed: boolean
			originDomain: string | null
			expiresAt: string | null
	  }
	/** kase A: the backend authorized on the user's behalf — nothing signed. */
	| { t: "done"; hash: string | null; kase: "A" | "B" | "C" }
	| { t: "sending-claimable" }
	| { t: "claimable"; balanceId: string; hash: string; claimUrl: string }
	| { t: "error"; message: string }

/**
 * The most recent transaction on the account, straight from Horizon. The
 * wallet's signed envelope is submitted by the relayer, so the hash never
 * passes through this page — reading it back is what lets the screen link the
 * completed transaction rather than just say "it worked".
 */
async function latestTxHash(account: string): Promise<string | null> {
	if (!NETWORK.horizonUrl || StrKey.isValidContract(account)) return null
	try {
		const r = await fetch(
			`${NETWORK.horizonUrl}/accounts/${account}/transactions` +
				`?order=desc&limit=1&include_failed=false`,
		)
		if (!r.ok) return null
		const body = await r.json()
		return body?._embedded?.records?.[0]?.hash ?? null
	} catch {
		return null
	}
}

function Withdraw() {
	const [asset, setAsset] = useState(ASSET)
	const [address, setAddress] = useState("")
	const [amount, setAmount] = useState("250.00")
	const [phase, setPhase] = useState<Phase>({ t: "form" })
	const [status, setStatus] = useState<ActivationStatus | null>(null)
	const [copied, setCopied] = useState(false)
	const poll = useRef<number | null>(null)

	const stopPolling = useCallback(() => {
		if (poll.current !== null) {
			window.clearInterval(poll.current)
			poll.current = null
		}
	}, [])
	useEffect(() => stopPolling, [stopPolling])

	const readStatus = useCallback(
		(account: string) =>
			getActivationStatus({
				rpcUrl: NETWORK.rpcUrl,
				account,
				assetCode: asset.assetCode,
				assetIssuer: asset.assetIssuer,
				sac: asset.sac,
				networkPassphrase: NETWORK.passphrase,
				allowHttp: NETWORK.allowHttp,
			}),
		[asset],
	)

	const start = useCallback(async () => {
		const account = address.trim()
		if (
			!StrKey.isValidEd25519PublicKey(account) &&
			!StrKey.isValidContract(account)
		) {
			setPhase({
				t: "error",
				message:
					"That is not a Stellar address. Paste the G… (or smart-account C…) " +
					"address your wallet shows for this network.",
			})
			return
		}
		if (!RELAYER_URL) {
			setPhase({
				t: "error",
				message:
					"No relayer configured (PUBLIC_RELAYER_URL). The withdrawal screen " +
					"needs the relayer as its backend to build and sign SEP-7 requests.",
			})
			return
		}
		setPhase({ t: "building" })
		try {
			// The backend does the work: readiness check, transaction build,
			// signed SEP-7 request. This page never sees a key.
			const res = await fetch(`${RELAYER_URL}/v1/sep7/request`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					account,
					asset: asset.assetCode,
					msg: `Northwind Exchange: activate ${asset.assetCode} to receive your ${amount} ${asset.assetCode} withdrawal`,
				}),
			})
			const body = (await res.json()) as Sep7RequestResponse
			if (!res.ok)
				throw new Error(
					body.detail ?? body.error ?? `relayer answered HTTP ${res.status}`,
				)
			if (body.alreadyAuthorized || body.case === "ready") {
				setStatus(await readStatus(account).catch(() => null))
				setPhase({ t: "ready-already" })
				return
			}
			// Case A: the trustline existed and only lacked authorization. The
			// backend submitted it on the user's behalf — zero signatures.
			if (body.case === "A") {
				setStatus(await readStatus(account).catch(() => null))
				setPhase({ t: "done", hash: body.txHash ?? null, kase: "A" })
				return
			}
			if (!body.sep7Uri)
				throw new Error("the relayer returned no SEP-7 request")

			let qr: string | null = null
			if (new Blob([body.sep7Uri]).size <= QR_MAX_BYTES) {
				try {
					qr = await QRCode.toDataURL(body.sep7Uri, {
						errorCorrectionLevel: "L",
						margin: 1,
						width: 320,
					})
				} catch {
					qr = null
				}
			}
			setCopied(false)
			setPhase({
				t: "handoff",
				kase: body.case === "B" ? "B" : "C",
				createAccount: !!body.createAccount,
				uri: body.sep7Uri,
				handlerUrl: body.handlerUrl,
				qr,
				signed: !!body.signed,
				originDomain: body.originDomain ?? null,
				expiresAt: body.expiresAt ?? null,
			})

			// The relayer submits what the wallet returns; this page learns the
			// outcome the way any integrator would — by watching the ledger.
			stopPolling()
			poll.current = window.setInterval(async () => {
				try {
					const next = await readStatus(account)
					setStatus(next)
					if (isReady(next)) {
						stopPolling()
						setPhase({
							t: "done",
							hash: await latestTxHash(account),
							kase: body.case === "B" ? "B" : "C",
						})
					}
				} catch {
					/* transient RPC failure — keep watching */
				}
			}, 3000)
		} catch (e) {
			setPhase({
				t: "error",
				message: e instanceof Error ? e.message : String(e),
			})
		}
	}, [address, amount, asset, readStatus, stopPolling])

	/**
	 * Claimable-balance delivery: pay NOW, even though the wallet cannot
	 * receive a payment yet. The backend sends the amount as a claimable
	 * balance from its treasury; the user claims it later on the activation
	 * page, where (for an open asset) that one claim signature also opens the
	 * trustline.
	 */
	const sendClaimable = useCallback(async () => {
		const account = address.trim()
		if (!RELAYER_URL) return
		stopPolling()
		setPhase({ t: "sending-claimable" })
		try {
			const res = await fetch(`${RELAYER_URL}/v1/claimable/send`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ account, asset: asset.assetCode, amount }),
			})
			const body = (await res.json()) as {
				balanceId?: string
				txHash?: string
				claimUrl?: string
				error?: string
				detail?: string
			}
			if (!res.ok || !body.balanceId || !body.txHash || !body.claimUrl)
				throw new Error(
					body.detail ?? body.error ?? `relayer answered HTTP ${res.status}`,
				)
			setPhase({
				t: "claimable",
				balanceId: body.balanceId,
				hash: body.txHash,
				claimUrl: body.claimUrl,
			})
		} catch (e) {
			setPhase({
				t: "error",
				message: e instanceof Error ? e.message : String(e),
			})
		}
	}, [address, amount, asset, stopPolling])

	const reset = useCallback(() => {
		stopPolling()
		setStatus(null)
		setPhase({ t: "form" })
	}, [stopPolling])

	const copy = (uri: string) => {
		navigator.clipboard
			?.writeText(uri)
			.then(() => setCopied(true))
			.catch(() => {})
	}

	return (
		<main className="shell">
			<header className="bar">
				<div className="brand">
					<span className="mark">N</span>
					<span>Northwind Exchange</span>
				</div>
				<span className="net">{NETWORK_LABEL}</span>
			</header>

			<section className="card">
				<p className="eyebrow">Withdraw</p>
				<h1>Send {asset.assetCode} to your wallet</h1>
				<p className="lede">
					A reference integrator. It holds none of your keys and has no wallet
					integration: its backend builds a signed SEP-7 request, and your own
					wallet signs the one transaction that lets you receive{" "}
					{asset.assetCode}.
				</p>

				{phase.t === "form" || phase.t === "error" ? (
					<div className="form">
						<label>
							<span>Asset</span>
							<select
								value={asset.assetCode}
								onChange={(e) =>
									setAsset(
										LIVE_ASSETS.find((a) => a.assetCode === e.target.value) ??
											ASSET,
									)
								}
							>
								{LIVE_ASSETS.map((a) => (
									<option key={a.assetCode} value={a.assetCode}>
										{a.assetCode} — {a.name}
									</option>
								))}
							</select>
						</label>
						<label>
							<span>Amount</span>
							<input
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								inputMode="decimal"
							/>
						</label>
						<label className="wide">
							<span>Destination address</span>
							<input
								value={address}
								onChange={(e) => setAddress(e.target.value)}
								placeholder="G…"
								spellCheck={false}
								autoComplete="off"
							/>
						</label>
						{phase.t === "error" ? (
							<p className="error">{phase.message}</p>
						) : null}
						<button className="primary wide" onClick={start}>
							Continue to withdrawal
						</button>
					</div>
				) : null}

				{phase.t === "building" ? (
					<p className="working">
						Checking whether your wallet can already receive {asset.assetCode}…
					</p>
				) : null}

				{phase.t === "ready-already" ? (
					<div className="result ok">
						<h2>Your wallet is already set up</h2>
						<p>
							This address can already receive {asset.assetCode}, so the
							withdrawal is paid immediately — no signature needed.
						</p>
						<p className="links">
							<a
								href={expertAccount(address.trim())}
								target="_blank"
								rel="noreferrer"
							>
								View the account
							</a>
						</p>
						<button onClick={reset}>Use another address</button>
					</div>
				) : null}

				{phase.t === "handoff" ? (
					<div className="handoff">
						<h2>Approve in your wallet</h2>
						<p>
							{phase.kase === "B" ? (
								phase.createAccount ? (
									<>
										This address has no account on the network yet. We create it
										and pay its reserves for you — you sign once to accept the{" "}
										{asset.assetCode} trustline.
									</>
								) : (
									<>
										This account does not hold enough XLM for a trustline
										reserve, so we sponsor it — you sign once and pay nothing.
									</>
								)
							) : (
								<>
									Your wallet needs one signature before it can receive{" "}
									{asset.assetCode}. Open the request in your wallet, check it,
									and approve. The signed transaction comes back to us and we
									submit it.
								</>
							)}
						</p>
						<p className="note">
							{phase.signed && phase.originDomain ? (
								<>
									Signed by <code>{phase.originDomain}</code> — your wallet
									verifies it against that domain’s <code>stellar.toml</code>.
								</>
							) : (
								<>
									Unsigned request (no <code>SEP7_ORIGIN_DOMAIN</code> on the
									relayer) — your wallet will show it as unverified.
								</>
							)}
						</p>
						{phase.qr ? (
							<img
								className="qr"
								src={phase.qr}
								alt="SEP-7 request QR code — scan with a Stellar wallet"
							/>
						) : (
							<p className="note">
								This request is too large to fit in a QR code — use a link
								below.
							</p>
						)}
						<div className="actions">
							{phase.handlerUrl ? (
								<a
									className="primary"
									href={phase.handlerUrl}
									target="_blank"
									rel="noreferrer"
								>
									Sign with Authline
								</a>
							) : null}
							<a href={phase.uri}>Open in wallet</a>
							<a href={albedoUrl(phase.uri)} target="_blank" rel="noreferrer">
								Open in Albedo
							</a>
							<button onClick={() => copy(phase.uri)}>
								{copied ? "Copied" : "Copy request"}
							</button>
						</div>
						<ul className="choices">
							<li>
								<b>Sign with Authline</b> — opens the request on authline.io,
								where any Stellar wallet you connect (Freighter, xBull, Hana,
								Albedo…) signs it. Works whatever wallet you use.
							</li>
							<li>
								<b>Open in wallet</b> — a <code>web+stellar:</code> link, for a
								wallet registered to handle them (Lobstr on mobile, Albedo or
								Authline once you registered them in your browser).
							</li>
							<li>
								<b>Scan the QR</b> — with a mobile wallet that reads SEP-7
								codes.
							</li>
						</ul>
						<details>
							<summary>Show the SEP-7 request</summary>
							<code className="uri">{phase.uri}</code>
						</details>
						<p className="watching">
							Waiting for your wallet to sign…
							{status?.hasTrustline
								? " trustline created, awaiting authorization."
								: ""}
							{phase.expiresAt
								? ` The request expires at ${new Date(phase.expiresAt).toLocaleTimeString()}.`
								: ""}
						</p>
						{StrKey.isValidEd25519PublicKey(address.trim()) ? (
							<div className="alt">
								<p>
									<b>Can’t sign right now?</b> We can send the {amount}{" "}
									{asset.assetCode} anyway, as a claimable balance you collect
									later from your wallet on the activation page.
								</p>
								<button onClick={sendClaimable}>
									Send as claimable balance instead
								</button>
							</div>
						) : null}
						<button className="quiet" onClick={reset}>
							Cancel
						</button>
					</div>
				) : null}

				{phase.t === "sending-claimable" ? (
					<p className="working">
						Sending {amount} {asset.assetCode} as a claimable balance…
					</p>
				) : null}

				{phase.t === "claimable" ? (
					<div className="result ok">
						<h2>Sent — waiting for you to claim</h2>
						<p>
							{amount} {asset.assetCode} is on the network as a claimable
							balance in your name. Open the activation page with your wallet
							and claim it: one signature collects it and opens your{" "}
							{asset.assetCode} trustline if you don’t have one yet.
						</p>
						<div className="actions">
							<a
								className="primary"
								href={phase.claimUrl}
								target="_blank"
								rel="noreferrer"
							>
								Claim on Authline
							</a>
							<a href={expertTx(phase.hash)} target="_blank" rel="noreferrer">
								Delivery transaction
							</a>
						</div>
						<p className="note">
							Balance id <code>{phase.balanceId.slice(0, 10)}…</code>. Unclaimed
							balances return to us after 30 days.
						</p>
						<button onClick={reset}>Start over</button>
					</div>
				) : null}

				{phase.t === "done" ? (
					<div className="result ok">
						<h2>Activated — withdrawal can be paid</h2>
						<p>
							{phase.kase === "A" ? (
								<>
									Your trustline only lacked the issuer’s authorization, and
									that needs no signature from you: we submitted it. This
									address can now receive {asset.assetCode}, so {amount}{" "}
									{asset.assetCode} can be sent to it.
								</>
							) : (
								<>
									Your wallet signed the request and the network accepted it.
									This address can now receive {asset.assetCode}, so {amount}{" "}
									{asset.assetCode} can be sent to it.
								</>
							)}
						</p>
						<p className="links">
							{phase.hash ? (
								<a href={expertTx(phase.hash)} target="_blank" rel="noreferrer">
									Transaction {phase.hash.slice(0, 8)}…{phase.hash.slice(-8)}
								</a>
							) : null}
							<a
								href={expertAccount(address.trim())}
								target="_blank"
								rel="noreferrer"
							>
								View the account
							</a>
						</p>
						<button onClick={reset}>Start over</button>
					</div>
				) : null}
			</section>

			<footer className="foot">
				Reference integrator for the Trustline Onboarder SEP — Cases A, B, C and
				claimable-balance delivery. Backend: the Authline relayer (
				<code>/v1/sep7/request</code>, <code>/v1/sep7/callback</code>,{" "}
				<code>/v1/claimable/send</code>).
				{RELAYER_URL ? (
					<>
						{" "}
						Relayer: <code>{RELAYER_URL}</code>
					</>
				) : null}
			</footer>
		</main>
	)
}

createRoot(document.getElementById("root")!).render(<Withdraw />)
