# Helicopter Humans

A privacy layer for your agent. Don't be a helicopter human. Let your agent have a little bit of privacy.

## Start expose402, the free local trace utility

Requires Node.js 24+. One command starts bounded discovery and a read-only preview:

```sh
npx --yes expose402@0.1.0
```

Choose a supported LangGraph history file or a clearly invented demo. Removal requires explicit thread selection, impact review, a stopped agent and typed confirmation. It deletes selected threads' entire saved history; empty selection and cancellation remove nothing. No Python, account, wallet, payment, telemetry or history upload. npm downloads the package; the tool itself stays local.

The [npm package](https://www.npmjs.com/package/expose402) is published as `expose402@0.1.0`. The [current guide](https://helicopter-humans.vercel.app/traces-guide.txt) covers supported sources, exact discovery paths, limits and recovery receipts. The matching archive remains available as an advanced download. The raw [Python tool](docs/PAYMENT_TRACE_CLEANER.md) remains an advanced option.

## Current and historical source surfaces

| Part | State | Where |
| --- | --- | --- |
| Offline log tool | Free single-file download. Local text-file input, exact-phrase masking, editable preview, reviewed export and clear. Public page is sample-only | `src/offline.ts`, `src/redact.ts`, `docs/OFFLINE_LOG_TOOL.md` |
| expose402 | Free guided Node CLI published on npm. Bounded discovery, read-only preview and explicitly confirmed whole-thread removal. Zero runtime dependencies or network calls | `packages/traces/`, `packages/traces/README.md` |
| z402 | Design proposal for payment/transport unlinkability by default; no deployed proof/verifier, shielded-credit ledger or rollup | `docs/Z402_DESIGN.md` |
| classified.exe terminal | Demo with invented text only. Unknown input is not echoed or retained in history | `src/terminal.ts` |
| Checkout button | Always off. No build variable can open it | `src/main.ts` |
| Invoice checkout (Founding Agent Pass preorder) | Prototype, collection hard-disabled. Runs only as a local fixture (`CHECKOUT_MODE=fixture`, never on a host). Draft offer, not approved | `src/checkout/`, `api/checkout/`, `checkout.html`, `docs/CHECKOUT.md` |
| `GET/POST /api/checkout/orders`, `GET/POST /api/checkout/order` | Fail closed: HTTP 503 `checkout_disabled` on every deployment while any checkout blocker remains in code | `api/checkout/` |
| Shielded ZEC payment check | Prototype, collection off. Verify-only package tested offline; no route issues a quote, address or payment challenge | `packages/payment-adapter/`, `src/payments/` |
| `POST /api/pay/quote`, `POST /api/pay/settle` | Fail closed: always HTTP 503 `payments_disabled` until every live-readiness blocker is cleared in code | `api/pay/` |
| Agent relay | Local prototype only: loopback, one local token, fixed Hacker News routes. Not deployed; `/api/status` reports `relay.mode: "unavailable"` | `src/relay/`, `docs/RELAY.md`, `examples/relay/` |
| CipherPay testnet check | Operator-run preflight and harness, testnet only. No mainnet invoice possible; not payment evidence for launch | `src/sandbox/`, `db/sandbox/`, `docs/SANDBOX_TEST.md` |
| `GET /api/status` | Service shell health check: active payment adapter, checkout and relay, whether each is collecting or available, and their blockers | `api/status.ts` |

The site loads no analytics, third-party scripts or web fonts. Keep it that way; an e2e test enforces it.

## Stack

Vite + TypeScript, no framework. Static output in `dist/`. Vercel-style functions in `api/`. Runtime dependencies are the in-repo npm workspace `packages/payment-adapter` (zero registry dependencies) and `pg` for the checkout's PostgreSQL order store. Both are used by the functions, never by the page. Node 24+.

## Commands

```sh
npm install
npm run dev        # local dev server
npm run check      # typecheck + lint + unit tests (Vitest, then the package's node:test suite) + production build
npm run test:e2e   # Playwright, desktop + mobile, site build and checkout fixture (first run: npx playwright install chromium)
npm run test:pg    # checkout service contract against real PostgreSQL; needs CHECKOUT_PG_TEST_URL (see docs/CHECKOUT.md)
CHECKOUT_MODE=fixture npm run dev   # checkout preview at /checkout.html with a simulated provider
npm run build      # production build to dist/
npm run test:traces # focused discovery, cancellation, deletion, stale/rollback/lock/limit checks
npm run verify:traces-pack # clean-install the built archive outside the repo; exercise its installed bin with only Node on PATH
npm run relay      # local prototype agent relay on http://127.0.0.1:8749 (see docs/RELAY.md)
npm run sandbox -- preflight   # CipherPay testnet readiness, read-only (see docs/SANDBOX_TEST.md)
```

## Configuration

Copy `.env.example`. Names only; values are set in the hosting provider.

| Variable | Scope | Effect |
| --- | --- | --- |
| `VITE_PRICE_LABEL` | build-time, public | Price text on the pass card, e.g. `$9 one-off`. Empty: "Price not set". |
| `CHECKOUT_MODE` | server, local only | `fixture` runs the checkout against a simulated provider and memory store. Ignored on any host (`VERCEL`, `VERCEL_ENV` or `NODE_ENV=production` set). Nothing else enables the checkout; see `docs/CHECKOUT.md`. |
| `PAYMENT_ADAPTER` | server (`api/`) | Payment adapter id: `disabled` or `cipherpay-zcash-shielded`. Unknown ids fall back to `disabled`. Selecting the Zcash adapter does not enable collection; see `docs/PAYMENT_ADAPTER.md`. |

The package's own variables (`CIPHERPAY_API_KEY`, `ZCASH_PAYTO_UA`, `ZCASH_PRICE_ZATOSHIS`, ...) are documented in `packages/payment-adapter/README.md`. Do not set them on a deployment: nothing reads them while collection is off.

`VITE_*` values are baked in at build time, so redeploy after changing them.

## Deploy

Any static host works for the site (`npm run build`, publish `dist/`). On Vercel, import the repo with the Vite preset; `api/status.ts` deploys as a function automatically.

The production website is https://helicopter-humans.vercel.app. Reuse Vercel project `prj_mxlq6EQHo1XnkTJYnvgJw34gHuFo` (`helicopter-humans`) in team `redemption-c64d16c8`. Its settings are Vite, Node 24, install `npm ci`, build `npm run build`, output `dist`. No checkout or payment credentials are configured for the initial website milestone.

From the reviewed source revision, with Vercel CLI access to that team:

```sh
vercel link --yes --scope redemption-c64d16c8 --project prj_mxlq6EQHo1XnkTJYnvgJw34gHuFo
npm ci
npm run check
npm run test:e2e
vercel pull --yes --environment=production --scope redemption-c64d16c8
vercel build --prod --scope redemption-c64d16c8
node --input-type=module -e 'const { GET } = await import("./.vercel/output/functions/api/status.func/api/status.js"); const res = GET(); if (res.status !== 200) throw new Error("Status handler failed"); console.log(await res.text())'
node --input-type=module -e 'const { POST } = await import("./.vercel/output/functions/api/pay/quote.func/api/pay/quote.js"); const res = await POST(new Request("https://x/", { method: "POST", body: "{\"productId\":\"founding-pass\"}" })); if (res.status !== 503) throw new Error("Quote route did not fail closed"); console.log(await res.text())'
npm run smoke:functions   # built checkout/pay/status functions: 503 with a full env, no network call
vercel deploy --prod --yes --scope redemption-c64d16c8
```

The emitted-function smoke check matters: Vite/Vitest resolve extensionless imports, while Node ESM in the deployed function requires `.js` import specifiers. Keep those extensions throughout the function's runtime dependency chain. The functions import the `packages/payment-adapter` workspace; `vercel build` copies it into each function and records the `node_modules` link in `.vc-config.json` (`filePathMap`). If deploying the exact local Vercel build instead, add `--prebuilt` to the deploy command.

The landing page leads with the guided Node package and a copyable, versioned registry command. After deployment, execute that public command with a fresh npm cache, verify the package/guide bytes against `traces-sha256.json`, and check the start flow, clipboard fallback, whole-thread explanation, FAQ, helicopter motion and reduced-motion alternative on desktop/mobile. The isolated historical source/artifacts are not landing-page offers. `/checkout.html` must remain closed. `GET /api/status` must report payment/checkout collection false and the public quote/order POST routes must return 503. Protocol protection remains unimplemented.

Do not enable the Founding Pass merely by adding a link: price, payout account, deliverable and refund terms must be settled first. The payment adapter is separate work. Merchant setup, a working shielded payer, durable replay storage, verified binding between a payment and its buyer/request, and an authorized end-to-end check are still required for live collection. No seed, spend key, or viewing key belongs in this repository.

## Payment adapter and checkout

`docs/RELAY.md` covers the local agent relay: privacy boundary, request/response and access contracts, SSRF controls, and the remaining step to usage credit. `docs/SANDBOX_TEST.md` is the operator runbook for the testnet check, the wallet evidence and the PostgreSQL deployment proposal.

`docs/CHECKOUT.md` covers the CipherPay invoice checkout: order binding, states, the PostgreSQL store and migrations, secure configuration, readiness blockers and limitations. `docs/PAYMENT_ADAPTER.md` covers the earlier txid/x402 path, which stays disabled and is not the checkout.
