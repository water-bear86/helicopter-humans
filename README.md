# Helicopter Humans

A privacy layer for your agent. Don't be a helicopter human. Let your agent have a little bit of privacy.

## What is live

| Part | State | Where |
| --- | --- | --- |
| Log redactor | Live. Runs entirely in the browser, no network calls | `src/redact.ts` |
| classified.exe terminal | Demo (the `redact` command is real) | `src/terminal.ts` |
| Checkout button | Off until `VITE_CHECKOUT_URL` is set | `src/config.ts`, `src/main.ts` |
| Paid privacy relay | Not built. Direct shielded ZEC verification prototype in development; no swaps or live payments | `src/payments/` (interface only) |
| `GET /api/status` | Service shell health check, reports active payment adapter | `api/status.ts` |

The site loads no analytics, third-party scripts or web fonts. Keep it that way; an e2e test enforces it.

## Stack

Vite + TypeScript, no framework, no runtime dependencies. Static output in `dist/`. One Vercel-style function in `api/`.

## Commands

```sh
npm install
npm run dev        # local dev server
npm run check      # typecheck + lint + unit tests + production build
npm run test:e2e   # Playwright, desktop + mobile (first run: npx playwright install chromium)
npm run build      # production build to dist/
```

## Configuration

Copy `.env.example`. Names only; values are set in the hosting provider.

| Variable | Scope | Effect |
| --- | --- | --- |
| `VITE_CHECKOUT_URL` | build-time, public | HTTPS payment link for the Founding Agent Pass. Empty or non-HTTPS: button stays disabled and says checkout is not open. |
| `VITE_PRICE_LABEL` | build-time, public | Price text on the pass card, e.g. `$9 one-off`. Empty: "Price not set". |
| `PAYMENT_ADAPTER` | server (`api/`) | Payment adapter id. Only `disabled` exists today. Unknown ids fall back to `disabled`. |

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
vercel deploy --prod --yes --scope redemption-c64d16c8
```

The emitted-function smoke check matters: Vite/Vitest resolve extensionless imports, while Node ESM in the deployed function requires `.js` import specifiers. Keep those extensions throughout the function's runtime dependency chain. If deploying the exact local Vercel build instead, add `--prebuilt` to the deploy command.

After deployment, exercise the redactor sample and empty-input error, terminal keyboard commands, reduced motion, and disabled checkout on desktop and mobile. Check that `GET /api/status` returns HTTP 200 and `payments.mode: "disabled"`. Do not treat a successful static build as proof that the server function runs.

Do not enable the Founding Pass merely by adding a link: price, payout account, deliverable and refund terms must be settled first. The payment adapter is separate work. Merchant setup, a working shielded payer, durable replay storage, verified binding between a payment and its buyer/request, and an authorized end-to-end check are still required for live collection. No seed, spend key, or viewing key belongs in this repository.

## Payment adapter

See `docs/PAYMENT_ADAPTER.md` for the contract, file ownership and rules.
