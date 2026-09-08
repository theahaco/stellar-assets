# SEP-7 handoff — how a user signs an Authline onboarding request

The Trustline Onboarder SEP separates the party that _starts_ an onboarding (an
exchange paying a withdrawal) from the wallet that holds the user's key. The
bridge between them is a
[SEP-7](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md)
`web+stellar:tx` request: one URI that carries the transaction, who sent it, and
where the signed result should go. This document is the complete workflow as it
runs in production, and what each Authline component does in it.

## Actors

| Actor          | Holds                                        | In this repo                                                                       |
| -------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Integrator** | the user's address, a backend, a signing key | the **relayer** (`packages/relayer`) is the backend; `withdraw.html` is the screen |
| **User**       | a wallet, often on another device            | —                                                                                  |
| **Wallet**     | the user's key                               | any Stellar Wallets Kit wallet, via the **receiving page** `app.html?sep7=…`       |

## The flow

```
 Exchange screen            Exchange backend (relayer)        User's wallet              Ledger
 withdraw.html              POST /v1/sep7/request
      │── account, asset ──────────►│
      │                             │ readiness check; build onboard tx
      │                             │ sign request as origin_domain
      │◄── sep7Uri, handlerUrl ─────┤
      │ show QR · web+stellar: link · "Sign with Authline"
      │                                                          │
      │  (user scans / clicks) ─────────────────────────────────►│ app.html?sep7=…  or a native SEP-7 wallet
      │                                                          │ verify signature vs origin_domain/stellar.toml
      │                                                          │ show sender, message, what the tx does
      │                                                          │ user approves → 1 signature
      │                             │◄── POST /v1/sep7/callback  xdr=<signed> ─┤
      │                             │ validate shape, (countersign), submit ─────────────────────►│
      │                             │── { txHash } ─────────────►│ shows the hash
      │ (polls the ledger) ◄────────────────────────────────────────────────────────────────────┤
      │ "Activated — withdrawal can be paid"
```

### 1. The integrator's backend diagnoses the case and builds a signed request

`POST /v1/sep7/request` with `{ account, asset?, msg? }` first reads the ledger
and picks the SEP's case for this holder:

| `case`  | Ledger state                                        | What the backend does                                                                                                                                                                                            | User signatures |
| ------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `ready` | authorized trustline (or open-asset trustline)      | nothing — `alreadyAuthorized: true`                                                                                                                                                                              | 0               |
| `A`     | trustline exists, not authorized (regulated asset)  | submits `authorize_trustline` itself, returns `txHash`. No request is handed out.                                                                                                                                | **0**           |
| `B`     | no account, or under ~1.6 XLM (cannot pay reserves) | builds the CAP-33 sponsored `ChangeTrust` (+ `CreateAccount`), **signs as sponsor**, emits the SEP-7 request. On the callback it submits, then authorizes a regulated asset in a second transaction it pays for. | **1**           |
| `C`     | funded account, no trustline                        | builds the CAP-73 router `onboard`, emits the SEP-7 request                                                                                                                                                      | **1**           |

A smart-account (C-address) holder is always `C`, with the relayer as fee
source. For `B` and `C` the answer is:

```json
{
	"account": "G…",
	"asset": "USDC",
	"alreadyAuthorized": false,
	"sep7Uri": "web+stellar:tx?xdr=…&network_passphrase=…&callback=url%3A…&msg=…&origin_domain=authline-relayer.fly.dev&signature=…",
	"handlerUrl": "https://authline.io/app.html?sep7=web%2Bstellar%3Atx%3F…",
	"callback": "https://authline-relayer.fly.dev/v1/sep7/callback",
	"signed": true,
	"originDomain": "authline-relayer.fly.dev",
	"expiresAt": "2026-09-04T12:03:00.000Z"
}
```

- The transaction is the CAP-73 router `onboard(sac, holder)` — one operation,
  one holder signature. For a G-account it is holder-sourced; for a
  smart-account (C-address) holder the relayer is the fee source.
- The request is **signed** with the key the relayer publishes in its own
  `/.well-known/stellar.toml` as `URI_REQUEST_SIGNING_KEY`, and names that host
  as `origin_domain`. Wallets verify this before showing the sender as trusted.
  Without `SEP7_ORIGIN_DOMAIN` the request goes out unsigned and wallets show it
  as unverified.
- `callback` points back at the relayer: the wallet returns the signed envelope
  instead of submitting, so the integrator learns the result directly.
  `handlerUrl` wraps the same request for the receiving page.
- Case B costs the relayer the reserves it sponsors (about 1 XLM for a new
  account plus 0.5 XLM per trustline); they return to it when the sponsored
  entries are removed. The sponsored envelope is sourced by the relayer, so its
  sequence number is consumed at build time: the user should sign within the
  3-minute window, and a relayer under concurrent load may need channel
  accounts.

An exchange's own backend can do exactly the same with the SDK:
`buildOnboardTx()` +
`onboardingRequest({ callback, hostedBase, originDomain, signer })`.

### 2. The screen shows three ways to open it

`withdraw.html` (the reference "Northwind Exchange" screen) shows:

- **QR code** — for a mobile wallet that scans SEP-7 codes.
- **Open in wallet** — the raw `web+stellar:` link, for a wallet registered to
  handle the scheme (Lobstr on mobile; Albedo or Authline once registered in the
  browser).
- **Sign with Authline** — `handlerUrl`: the receiving page, which works
  whatever wallet the user has.

It then polls the ledger and, once the account is ready, links the transaction.

### 3. The receiving page: `app.html?sep7=…`

Most desktop wallets (Freighter, xBull, Hana) do not register `web+stellar:`.
The Authline activation page fills that gap — it is the wallet-side of SEP-7 for
any Stellar Wallets Kit wallet:

1. Parses the request and refuses anything that is not a `tx` request for this
   network, before decoding anything else.
2. Fetches `origin_domain`'s `stellar.toml` and verifies `signature` against
   `URI_REQUEST_SIGNING_KEY`: **Verified**, **Unverified** (unsigned, or the
   toml could not be read from the browser), or **Bad signature** (a key exists
   and does not match — signing is disabled).
3. Explains the transaction in words: "Activate USDC" for which account, the
   network, the maximum fee, any co-signers, and whether the result is returned
   to the sender or submitted here. The raw operations and URI are one click
   away.
4. The user connects a wallet. If the connected account is not the one the
   request names, the page says so and offers to switch.
5. One signature. With a `callback` the signed envelope is POSTed there
   (form-encoded `xdr=`, as SEP-7 specifies) and the callback's `txHash` is
   shown; otherwise the page submits to the network and shows the hash.
6. "Open future web+stellar: links here" registers the page as the browser's
   `web+stellar:` handler (`navigator.registerProtocolHandler`), so the next raw
   link an exchange shows opens straight into it.

### 4. Claimable-balance delivery: `POST /v1/claimable/send`

When the user cannot sign now, the exchange still pays:
`{ account, asset, amount }` sends the amount **from the relayer's own
treasury** as a claimable balance naming the user (30-day reclaim back to the
sender), and returns the balance id, the delivery hash and a `claimUrl` — the
activation page previewing that account for that asset. Connecting the wallet
there routes into the claim screen: for an open asset one claim signature opens
the trustline and collects the balance in the same transaction; for a regulated
asset the user activates first (or the exchange runs Case A) and then claims.

The relayer therefore holds float. `npm run fund:treasury -- --relayer <alias>`
sets a testnet relayer up with an authorized EURCV trustline plus USDC and EURCV
balances, from the keystore identities `e2e-usdc-sender` and `eurcv-issuer`.
Per-request amounts are capped by `CLAIMABLE_MAX_AMOUNT`.

### 5. The callback: `POST /v1/sep7/callback`

Anyone can reach it (the user's wallet calls it, so there is no bearer token),
so its validation is the whole security boundary. It accepts exactly the
transactions `/v1/sep7/request` emits — one op, the pinned router's
`onboard(<pinned SAC>, holder)` — in two forms:

- **holder-sourced** (G-account): must already carry the wallet's signature; the
  relayer submits as-is and spends nothing.
- **relayer-sourced** (fee source for a smart-account holder): every auth entry
  must be _address_ credentials for the holder — never source-account
  credentials, which would turn the relayer's signature into the authorization;
  fee ≤ `SEP7_MAX_FEE_STROOPS`; the relayer countersigns.

Anything else is refused as `400 not_countersignable`. An already-ready holder
answers `alreadyAuthorized: true` without a submission. The endpoint is on by
default on a loopback bind and off elsewhere — `ALLOW_SEP7_CALLBACK=1` enables
it on a hosted instance (see the [relayer runbook](relayer-runbook.md)).

## The integrator screen, state by state

`withdraw.html` ("Northwind Exchange", a fictional integrator) is the reference
consumer of all of the above. After the address and asset are entered it shows
exactly one of:

- **Already set up** — paid immediately.
- **Case A** — "Activated" straight away, with the authorization hash: the
  backend did it, the user signed nothing.
- **Case B / C** — "Approve in your wallet": QR, `web+stellar:` link, **Sign
  with Authline**, with copy that says whether reserves are being sponsored.
  Underneath, **Send as claimable balance instead** for a user who cannot sign
  now; that leads to "Sent — waiting for you to claim" with the **Claim on
  Authline** link.
- **Activated — withdrawal can be paid** with the transaction link once the
  ledger shows the account ready.

## Smart-account holders (passkey wallets such as Nido)

A contract account cannot sign a classic envelope, so a SEP-7 `tx` request for
it needs a fee source that signs _after_ the wallet. That is what `callback`
exists for: the request is built with the relayer as fee source, the wallet
signs the holder's authorization entry, and the callback countersigns and
submits. Nido itself does not handle `web+stellar:` links today; a Nido user
goes through the receiving page, which drives Nido's sign ceremony.

## Running it locally

```bash
npm run build -w @theahaco/authline-relayer
RELAYER_SECRET=S… HOST=127.0.0.1 SEP7_PUBLIC_URL=http://127.0.0.1:8787 \
  SEP7_HANDLER_BASE=http://localhost:5173/app.html DEFAULT_ASSET=USDC \
  node packages/relayer/dist/server.js
PUBLIC_RELAYER_URL=http://127.0.0.1:8787 npm run dev:testnet   # then open /withdraw.html
```

A loopback relayer has no `stellar.toml` a browser can fetch over https, so
local requests are unsigned. The hosted instance signs as
`authline-relayer.fly.dev`.

## Proof on testnet

`npm run test:e2e -- tests/e2e/sep7-handoff.spec.ts` runs the whole flow in a
browser against testnet: the withdrawal screen, a loopback relayer, the
receiving page with a Node-side signer standing in for Freighter, the callback,
and the exchange screen seeing the ledger change. Every run produces a fresh
testnet transaction hash.

## Recording checklist

1. Open `https://authline.io/withdraw.html`, paste a funded testnet address with
   no trustline for the chosen asset, continue.
2. Click **Sign with Authline** (Freighter path) — or **Open in Albedo** — and
   show the request screen: sender **Verified**, the message, "Activate X".
3. Approve in the wallet.
4. Show the hash on the receiving page and on the exchange screen, and open it
   on stellar.expert.
