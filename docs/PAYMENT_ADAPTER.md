# Payment adapter

Collection is off. Nothing in this repository can take a payment today, and no environment variable changes that.

## Where things live

| Piece | Owns | Path |
| --- | --- | --- |
| Package `@helicopter-humans/payment-adapter` | x402 v2 challenge, `PAYMENT-SIGNATURE` parsing, CipherPay verify call, signed quote ids, receipt-ledger contract, buyer/operator messages, integration blockers. Plain JavaScript, `node:test`, zero registry dependencies. Verify-only: never holds keys, broadcasts, swaps or moves funds. | `packages/payment-adapter/` (read its `README.md`) |
| Site contract | What the page and routes may rely on: `Quote`, `PaymentResult`, `PaymentAdapter` | `src/payments/types.ts` |
| Site wrapper | Live-readiness guard, zatoshi/ZEC conversion, server-owned challenge lookup | `src/payments/adapters/zcash.ts` |
| Registry | Adapter id to factory. `PAYMENT_ADAPTER` selects; unknown ids fall back to `disabled` | `src/payments/registry.ts` |
| Routes | `GET /api/status`, `POST /api/pay/quote`, `POST /api/pay/settle` | `api/`, handlers in `src/payments/http.ts` |

The package is an npm workspace linked from the root `package.json`; the functions import it by name. It stays an isolated package with its own tests. Do not copy it into `src/`.

## The live-readiness guard

`liveReadiness()` in `src/payments/adapters/zcash.ts` is the only switch. It is ready only when the package's `INTEGRATION_BLOCKERS` and the site's own blockers are both empty, and both are code, not configuration. While it is not ready:

- `createZcashAdapter()` (the registry entry) returns a refusing adapter without constructing the package adapter, so no payable address or challenge exists and no provider call can happen, however complete the environment looks.
- `/api/pay/*` return HTTP 503 `{"error":"payments_disabled"}` for any adapter whose mode is not `live`: no quote, no address, no `PAYMENT-REQUIRED` header.
- `/api/status` reports `mode: "disabled"`, `collecting: false` and the blocker ids.

Current blockers:

| Id | Owner | Cleared by |
| --- | --- | --- |
| `no_payer_binding` | package | A provider-supported invoice/memo binding or another verified way to tie a txid to its payer. A txid alone is public. |
| `no_end_to_end_payment` | package | One authorised tiny mainnet payment verified by this code. |
| `no_confirmed_payer` | package | A client that demonstrably builds a fully shielded spend to our unified address. |
| `no_durable_ledger_deployed` | package | A deployed receipt ledger whose `claim` is atomic across every instance. |
| `no_durable_challenge_store` | site | A shared store for issued challenges. The wrapper's `LocalChallengeStore` is per process. |

Also required before launch, outside code: merchant setup, a confirmed payout address, an approved price, a user-facing fee statement and refund terms. Do not create accounts, wallets or databases just to get past the guard.

`createLocalZcashAdapter()` exists for offline tests. It requires an injected ledger and facilitator and refuses any non-loopback facilitator URL. Its `test` mode means "our own local fixture", not a provider testnet; CipherPay does not run one. The registry never builds it.

## Amounts and fees

- The package speaks integer zatoshis (`"100000"`). `src/payments/types.ts` speaks whole asset units (`"0.001"` ZEC). The wrapper converts with exact BigInt arithmetic in `zatoshisToZec` / `zecToZatoshis`; both reject floats, exponents, signs and more than 8 decimals. 100000 zatoshis is 0.001 ZEC, never 100000 ZEC.
- The wrapper issues challenges with the package's native `createChallenge` and settles with `authorize`. It does not use the package's `quote()`/`settle()` shims, because those rebuild a challenge from the caller's quote object.
- `adapterFee: "0"` means the adapter adds nothing on top of `amount`. `networkFeeIncluded: false` means the payer's wallet also pays a Zcash network fee we do not quote, and CipherPay bills the merchant separately. Never present `amount + adapterFee` as the total cost.
- The signed zatoshi amount in the stored challenge is the price. `fee`, `description` and `mimeType` are not covered by the quote mac and are never trusted from a client.

## Settle rules

- `settle` takes only `quoteId` and `amount` from the caller. It looks up the challenge the server issued; an unknown id fails with `unknown_quote`, and an amount that does not convert to exactly the stored zatoshis fails with `quote_amount_mismatch`, both before any provider call.
- A signed quote proves the server issued those terms. It does not prove who paid. That is `no_payer_binding`, and it keeps the public flow off.
- One txid grants one resource, enforced through the injected ledger. A payment left pending when its quote expires stays reserved under the old quote id; resubmitting that txid under a fresh quote fails with `txid_already_claimed` and needs an operator. Never tell a buyer who may have paid to send a second transfer.

## Rules

- Never accept, request or store seed phrases, spend keys or viewing keys.
- `payTo` comes from server configuration only. No default payout address, and never from request input.
- `privacyNote` is shown verbatim and must match what the adapter actually does. The disabled adapter says only that no payment data is collected.
- Runtime imports in `api/` and everything it pulls in use `.js` specifiers; the deployed function runs as Node ESM.

## Tests

`npm test` runs Vitest (`src/**/*.test.ts`) and then every workspace's own `npm test` (`node --test` for the package). `src/payments/adapters/zcash.test.ts` covers conversion, the guard and the local fixture flow; `src/payments/routes.test.ts` checks that a fully configured environment still gets 503s, no address and no provider call.
