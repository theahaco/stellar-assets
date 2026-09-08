# Authline relayer — integration guide and runbook

A small HTTP service that answers the two questions an exchange has about a
regulated Stellar asset, so integration takes ~20 lines of any language and **no
Stellar SDK**:

1. **Is this account ready to receive the asset?** —
   `GET /v1/accounts/{account}/ready`
2. **Authorize this account.** — `POST /v1/accounts/{account}/authorize`

The service is [`packages/relayer`](../packages/relayer); it wraps the
[`@theahaco/authline`](authline-sdk.md) SDK. On-chain, authorization is the
permissionless `authorize_trustline` entry point of the asset's
[Trustline Authorizer](authorizer-runbook.md) — the relayer just signs and pays
the fee, it holds **no authority**. The issuer's policy (denylist / allowlist /
pause) is enforced by the contract, not by this service.

---

## 1. The whole integration

Before paying out a withdrawal of a regulated asset (e.g. EURCV):

```python
import requests

RELAYER = "https://authline-relayer.fly.dev"     # hosted TESTNET instance, or your own

def ensure_ready(account: str, asset: str = "EURCV") -> bool:
    r = requests.get(f"{RELAYER}/v1/accounts/{account}/ready",
                     params={"asset": asset}).json()
    if r["ready"]:
        return True
    if r["reason"] == "trustline_unauthorized" and r.get("authorizable"):
        auth = requests.post(f"{RELAYER}/v1/accounts/{account}/authorize",
                             params={"asset": asset})
        return auth.status_code == 200
    # no_account → fund it (or use claimable-balance delivery);
    # no_trustline → the user onboards via the router / your sponsored flow;
    # authorizable == False → the issuer's policy refuses this account.
    return False
```

That is the entire client. Everything else in this document is operating the
service itself.

## 2. API

### `GET /healthz`

```json
{ "ok": true, "network": "TESTNET", "relayer": "G...", "defaultAsset": "EURCV" }
```

### `GET /v1/accounts/{account}/ready?asset=CODE`

`account` is a classic `G...` account or a `C...` contract holder (e.g. a
passkey smart account). `asset` defaults to the instance's `DEFAULT_ASSET`.
Always `200` for a valid address:

```json
{
	"account": "G...",
	"asset": "EURCV",
	"network": "TESTNET",
	"regulated": true,
	"ready": false,
	"reason": "trustline_unauthorized",
	"authorizable": true,
	"status": {
		"holderKind": "account",
		"accountExists": true,
		"hasTrustline": true,
		"isAuthorized": false,
		"sacAuthorized": false
	}
}
```

- **`ready`** — a payment of this asset to this account will succeed right now.
- **`reason`** (when not ready): `no_account` · `no_trustline` ·
  `trustline_unauthorized` · `not_authorized` (contract holders).
- **`authorizable`** — whether `POST /authorize` would fix it, read live from
  the issuer's policy (`is_eligible`). Omitted when the policy could not be read
  — absence means "unknown", never "yes".

### `POST /v1/accounts/{account}/authorize?asset=CODE`

Submits `authorize_trustline(account)` signed by the relayer's account and waits
for confirmation. No request body. Idempotent — authorizing a ready account is a
cheap success:

```json
{
	"account": "G...",
	"asset": "EURCV",
	"authorized": true,
	"alreadyAuthorized": false,
	"txHash": "9f2c…"
}
```

Refusals are typed, straight from the authorizer contract:

| HTTP | `error`               | Meaning / what to do                                                         |
| ---- | --------------------- | ---------------------------------------------------------------------------- |
| 400  | `asset_not_regulated` | open asset (USDC…): holders need no authorization                            |
| 400  | `invalid_account`     | not a Stellar address                                                        |
| 401  | `unauthorized`        | instance requires `Authorization: Bearer <token>`                            |
| 403  | `account_banned`      | issuer denylist — only the issuer can `unban`                                |
| 403  | `account_not_allowed` | allowlist policy: issuer has not admitted this account (KYC pending?)        |
| 404  | `unknown_asset`       | code not pinned for this network in the SDK registry                         |
| 409  | `no_trustline`        | create the trustline first (the onboard router does both in one transaction) |
| 503  | `authorizer_paused`   | issuer emergency stop — retry later                                          |
| 502  | `chain_error`         | RPC / network trouble — safe to retry                                        |
| 429  | `rate_limited`        | per-IP request budget exhausted — back off and retry                         |
| 503  | `too_busy`            | instance at its concurrency cap — retry with backoff                         |

### SEP-7 handoff — `POST /v1/sep7/request`, `POST /v1/sep7/callback`, `GET /.well-known/stellar.toml`

The relayer is also the **integrator backend for the SEP-7 handoff** (full
workflow: [sep7-handoff.md](sep7-handoff.md)).

`POST /v1/sep7/request` — JSON
`{ "account": "G…|C…", "asset": "CODE", "msg": "…" }`. Builds the one-signature
onboard transaction for `account`, wraps it in a `web+stellar:tx` request
**signed** as `SEP7_ORIGIN_DOMAIN`, with `callback` pointing back at this
relayer, and returns:

```json
{
	"account": "G...",
	"asset": "EURCV",
	"alreadyAuthorized": false,
	"sep7Uri": "web+stellar:tx?xdr=...&callback=url%3A...&origin_domain=...&signature=...",
	"handlerUrl": "https://authline.io/app.html?sep7=...",
	"callback": "https://authline-relayer.fly.dev/v1/sep7/callback",
	"signed": true,
	"originDomain": "authline-relayer.fly.dev",
	"expiresAt": "2026-09-04T12:03:00.000Z"
}
```

`alreadyAuthorized: true` (no request) for a ready account; `409 no_account` for
an unfunded G-account. No token: it costs no fee, only RPC reads.

`POST /v1/sep7/callback` — form-encoded `xdr=<signed envelope>` (SEP-7) or JSON
`{ "xdr": "…" }`. Called by the **user's wallet**, so no token; instead it
accepts exactly one transaction shape — the pinned router's
`onboard(<pinned SAC>, holder)` — holder-sourced and already signed (submit
only), or relayer-sourced for a smart-account holder with address-credential
auth entries only (countersign + submit, fee-capped). Everything else is
`400 not_countersignable`. Answers like `/authorize`:
`{ account, asset, authorized, alreadyAuthorized, txHash }`. Enabled by default
on a loopback bind; `ALLOW_SEP7_CALLBACK=1` elsewhere.

`POST /v1/claimable/send` — JSON
`{ "account": "G…", "asset": "CODE", "amount": "25" }`. Pays `amount` from the
relayer's own treasury as a claimable balance naming `account` (30-day reclaim),
for a recipient who cannot receive a payment yet. Returns
`{ balanceId, txHash, claimUrl }`; `claimUrl` is the activation page where the
user claims it. Capped per request by `CLAIMABLE_MAX_AMOUNT`. The relayer must
hold the asset: `npm run fund:treasury -- --relayer <alias>` funds a testnet
relayer with USDC and EURCV from the keystore identities.

`GET /.well-known/stellar.toml` — publishes `URI_REQUEST_SIGNING_KEY`, the key
wallets verify request signatures against. This is why `SEP7_ORIGIN_DOMAIN` must
be the relayer's own public host.

All responses carry permissive CORS headers (bearer auth, never cookies), so a
wallet page in a browser can call the callback.

## 3. Configuration

Environment variables, read once at boot (the process refuses to start
half-configured):

| Variable               | Required | Meaning                                                                                              |
| ---------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `RELAYER_SECRET`       | yes      | `S...` secret of a **funded, low-privilege** operations account                                      |
| `RELAYER_API_TOKEN`    | yes\*    | Bearer token for `POST /authorize`, **min 16 chars**. \*Optional only when `HOST` is loopback        |
| `STELLAR_NETWORK`      | no       | `TESTNET` (default) or `PUBLIC`                                                                      |
| `RPC_URL`              | no       | Stellar RPC override (defaults per network)                                                          |
| `DEFAULT_ASSET`        | no       | asset code when `?asset=` is omitted (default `EURCV`)                                               |
| `PORT`                 | no       | listen port (default `8787`)                                                                         |
| `HOST`                 | no       | bind interface (default `0.0.0.0`)                                                                   |
| `RATE_LIMIT_RPM`       | no       | per-IP requests/minute on the `/v1` routes (default `120`, `0` disables)                             |
| `MAX_INFLIGHT`         | no       | max concurrent `/v1` requests, `503 too_busy` beyond (default `8`, `0` disables)                     |
| `TRUST_PROXY`          | no       | `1`/`true`: client IP from `Fly-Client-IP` / `X-Forwarded-For` — **only behind a trusted proxy**     |
| `SEP7_ORIGIN_DOMAIN`   | no       | this relayer's public host (bare domain). Set → SEP-7 requests are signed; unset → unsigned          |
| `SEP7_SIGNING_SECRET`  | no       | dedicated `S...` key for request signing (default: the relayer key; signing a URI grants nothing)    |
| `SEP7_PUBLIC_URL`      | no       | public base URL for the `callback` (default `https://<SEP7_ORIGIN_DOMAIN>`, else `http://host:port`) |
| `SEP7_HANDLER_BASE`    | no       | receiving page for `handlerUrl` (default `https://authline.io/app.html`)                             |
| `ALLOW_SEP7_CALLBACK`  | no       | `1`/`true` serves `POST /v1/sep7/callback` (default: only on a loopback bind)                        |
| `SEP7_MAX_FEE_STROOPS` | no       | highest fee the callback countersigns for a smart-account holder (default `5000000` = 0.5 XLM)       |

**The key.** `authorize_trustline` is permissionless, so the relayer's account
has exactly one job: paying transaction fees. Use a dedicated operations account
holding a few XLM — **never** the authorizer admin key and never the asset
issuer key. If the key leaks, the attacker can spend your fee balance; they gain
no authority over the asset. Both bans are enforced at boot: the relayer
**refuses to start** if `RELAYER_SECRET` is a pinned asset's issuer key (checked
offline against the registry) or an authorizer admin key (checked by simulating
each pinned authorizer's `admin()`; an unreachable RPC only warns, so an outage
cannot keep a correct configuration down).

**The token.** Reads are free; writes cost you fees. The token is required
unless the service binds a loopback interface (`HOST=127.0.0.1` for local
development): an open `POST /authorize` lets anyone spend the fee balance. The
comparison is constant-time, and a token under 16 characters is refused at boot.
The token is **fee-abuse protection, never a compliance control** — the contract
refuses ineligible accounts no matter who asks.

**The limits.** Both `/v1` routes hit RPC on your quota, and an authorize can
block up to 60 s awaiting confirmation, so the service ships with per-IP rate
limiting (`429 rate_limited`) and a concurrency cap (`503 too_busy`); both are
safe to retry with backoff. `/healthz` is exempt so platform health checks never
queue behind chain work. Concurrent authorizes for the same account coalesce
into one submission, so a burst of identical requests costs one fee. Limits are
per-process — replicas behind a load balancer each apply their own, and edge
rate limiting can still be layered in front.

## 4. Running it

### Hosted instance

A reference instance runs at **`https://authline-relayer.fly.dev`** — **testnet
only**, default asset EURCV. Reads (`/healthz`, `/ready`) are open;
`POST /authorize` requires a bearer token (ask the operators). It is deployed
from this repo's [`fly.toml`](../fly.toml); production integrators should
self-host instead (below) with their own fee account and token.

### From the repo

```bash
npm install
npm run build -w @theahaco/authline-relayer
# Local development: loopback bind, no token needed.
RELAYER_SECRET=S... HOST=127.0.0.1 node packages/relayer/dist/server.js
```

### Docker (self-hosting)

The image is published on every relayer change as
`ghcr.io/theahaco/authline-relayer:latest` (and a commit-pinned tag), or build
it yourself from the repo root:

```bash
docker build -f packages/relayer/Dockerfile -t authline-relayer .
docker run -p 8787:8787 \
  -e RELAYER_SECRET=S... \
  -e STELLAR_NETWORK=TESTNET \
  -e RELAYER_API_TOKEN=change-me-16-chars-min \
  authline-relayer
```

The container is stateless — every answer comes from the ledger via RPC — so run
as many replicas as you like behind any HTTP load balancer; no shared state, no
sticky sessions. Concurrent authorizes for the same account are safe: within one
process they coalesce into a single submission; across replicas the second lands
as `alreadyAuthorized` or as a same-ledger no-op.

### Smoke test

```bash
curl -s localhost:8787/healthz
# any funded account works; this one is the hosted instance's own relayer account
curl -s localhost:8787/v1/accounts/GCB6N27Y6GTTMRBUQNYROIB5C37PWAJKLFRL7U3JXFZF7NQIJL2NS2TQ/ready
```

## 5. Operations

- **Fee balance.** The relayer account pays ~0.00001 XLM per authorize plus
  Soroban resource fees. Alert when its balance drops below ~5 XLM
  (`GET /healthz` names the account; watch it in Horizon/RPC).
- **Reserves and float.** Case B locks ~1–1.5 XLM of the relayer's balance per
  sponsored holder until the sponsored entries are removed, and
  `/v1/claimable/send` spends the treasury's asset balances. Watch both; the
  testnet instance is refilled with `npm run fund:treasury`.
- **Failure modes.** `503 authorizer_paused` means the issuer pulled the
  emergency brake — that is policy working, not an outage. `502 chain_error` is
  RPC trouble; the service holds no state, so restart/retry freely.
- **Logs and privacy.** The service logs nothing per-request by default and
  holds no databases. Everything it knows is already public chain state — see
  the [MiCA design note](mica-authorization-model.md).
- **Tests.** Unit tests: `npx vitest run packages/relayer` (mocked chain, run in
  CI). End-to-end against real testnet, including the full ready → authorize →
  ready flip driven over HTTP:
  `RUN_TESTNET_E2E=1 npx vitest run tests/e2e/testnet-relayer.e2e.test.ts`.
