# Helicopter Humans

A privacy layer for your agent. Don't be a helicopter human. Let your agent have a little bit of privacy.

## What is live

| Part | State | Where |
| --- | --- | --- |
| Log redactor | Live. Runs entirely in the browser, no network calls | `src/redact.ts` |
| classified.exe terminal | Demo (the `redact` command is real) | `src/terminal.ts` |
| Checkout button | Off until `VITE_CHECKOUT_URL` is set | `src/config.ts`, `src/main.ts` |
| Paid privacy relay | Not built. x402 / Zcash route under investigation | `src/payments/` (interface only) |
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

## Payment adapter

See `docs/PAYMENT_ADAPTER.md` for the contract, file ownership and rules.
