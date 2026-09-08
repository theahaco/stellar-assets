# Authline — integrator SDK + frontend rebrand

This PR brings the **Authline** experience to `stellar-assets`: the
`@theahaco/authline` integrator SDK **and** the Authline landing page +
activation dApp, wired together. The **backend is untouched** — same contracts
(`contracts/trustline-onboard`, `authorizer-stub`), the same onboarding logic
(`src/hooks/useOnboard.ts`, `src/contracts/assets.ts`), and authorization still
flows through the live `eurcv_auth`. Only the **frontend/design layer** changes.

## Two parts

### 1. `packages/authline-sdk/` — the integrator SDK (`@theahaco/authline`)

A small TypeScript SDK that lets a **third party** (exchange / broker / wallet)
establish a trustline **on behalf of a user** during a withdrawal — the core of
the "Trustline Onboarder" RFP. It is a real workspace package (the frontend
depends on it; `npm run build` builds it first).

| Need                             | Already in this repo                                                 |
| -------------------------------- | -------------------------------------------------------------------- |
| One-signature create + authorize | `contracts/trustline-onboard` → `onboard(sac, holder)`               |
| The authorize seam               | the live **`eurcv_auth`** SAC admin → `authorize_trustline(account)` |

Surface: `decodeOnboardStatus()` (decode the on-chain `OnboardStatus` return
value), `buildSponsoredOnboardTx()` (CAP-33 sponsored, reserve-free
`ChangeTrust` for a zero-XLM user), `buildOnboardTx()` (wraps this repo's
`onboard()`), `buildAuthorizeTx()` (permissionless authorize-on-behalf),
`onboardingRequest()` (SEP-7 + deep-link + hosted handoffs),
`discoverOnboarder()`/`parseOnboarderToml()` (StrKey-validated `stellar.toml`
discovery), a pinned `OFFICIAL_ASSETS` registry, an optional headless
`useActivation()` React hook, and the claimable-balance delivery set below.
There is **no Authline authorizer** — `authorize_trustline` is satisfied by
`eurcv_auth`.

#### SEP-7 handoff (wallet side)

`onboardingRequest()` emits a `web+stellar:tx` request; these are what the page
that _receives_ one needs (the Authline activation page is one such receiver:
`app.html?sep7=…` — see [sep7-handoff.md](sep7-handoff.md)):

| Function                | Role                                                                     |
| ----------------------- | ------------------------------------------------------------------------ |
| `parseSep7TxRequest()`  | parse + validate a `tx` request, refusing other networks before decoding |
| `fetchSep7SigningKey()` | read `URI_REQUEST_SIGNING_KEY` from `origin_domain`'s `stellar.toml`     |
| `verifySep7Signature()` | check the request's `signature` against that key                         |
| `describeSep7Tx()`      | explain the envelope: ops, signers, fee — recognises the router onboard  |
| `postSep7Callback()`    | return the signed envelope to the request's `callback` (form `xdr=`)     |
| `sep7HandlerUrl()`      | wrap a request for a hosted receiving page (`handlerUrl` in the result)  |

#### Claimable-balance delivery

For a recipient who isn't ready at all, a payment bounces. The exchange sends a
**claimable balance** instead, so the withdrawal completes with no user
involvement, and the user collects it later on the activation page.

| Function                          | Role                                                                  |
| --------------------------------- | --------------------------------------------------------------------- |
| `buildClaimableBalanceDelivery()` | exchange-side: pay a trustline-less user; optional reclaim window     |
| `planClaim()`                     | how this recipient claims, and how many signatures it costs them      |
| `buildClaimTx()`                  | the claim — optionally fusing the `ChangeTrust` that onboards them    |
| `getClaimableBalance()`           | read one balance off the ledger by id (RPC, no Horizon)               |
| `findClaimableBalances()`         | list what's waiting for an address (Horizon — opt-in, needs an index) |

For an **open** asset the user's ONE signature opens the trustline and claims
the balance in a single transaction; with a `sponsor` and `feeSource` they spend
no XLM at all.

For an **AUTH_REQUIRED** asset that is not possible, and the SDK says so rather
than building a doomed transaction: authorization is a Soroban call, a Soroban
invocation must be the only operation in its transaction (the network rejects
anything else with `Transaction contains more than one operation`), so it cannot
sit between the `ChangeTrust` and the claim. `planClaim()` returns the
three-step sequence — create trustline (user), authorize (**integrator, no user
signature**), claim (user). `tests/e2e/testnet-claimable.e2e.test.ts` proves
both paths on testnet, including that the fused regulated claim really is
rejected.

Runnable: `node examples/exchange-withdrawal/demo-claimable.mjs`.

### 2. The Authline frontend (landing + dApp)

- `index.html` — the Authline landing page (warm rebrand, "Hold any asset. In
  one tap.").
- `app.html` + `src/{main,authline,config}.tsx` — the activation dApp, wired to
  the SDK and Stellar Wallets Kit.
- `vite.config.ts` — multi-page (`index.html` + `app.html`), keeping the
  existing `nodePolyfills` + `wasm` plugins.

The previous React app (`src/App.tsx`, `src/components/*`, `src/hooks/*`) is
**kept in place** (the onboarding backend logic is preserved); the new entry
simply mounts the Authline dApp instead.

## Build / run

```bash
npm ci && npm run build      # builds the SDK, then the multi-page dapp
npm run dev                  # local dev
node examples/exchange-withdrawal/demo.mjs        # regulated path (testnet)
node examples/exchange-withdrawal/demo-open.mjs   # open path (testnet)
```

> `demo.mjs` (the regulated path) additionally requires the Rust
> [`stellar` CLI](https://github.com/stellar/stellar-cli) on your `PATH`,
> configured for testnet: it submits the `authorize_trustline` call via the CLI
> because the JS SDK cannot yet decode Protocol 26 trustline-write simulations.
> `demo-open.mjs` is pure JS and needs no CLI.

See the PR description for the file-by-file change list, the backend-untouched
guarantee, and the optional follow-up (the asset-agnostic authorizer contract).
