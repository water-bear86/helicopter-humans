# Payment adapter contract

Starting branch: `main` (after the 49TH-9 PR merges). Until then branch from `feat/49th-9-launch-site`.

## Interface

`src/payments/types.ts` is the contract. An adapter implements `PaymentAdapter`:

- `quote({ productId })` returns a `Quote` with explicit `amount`, `fee`, `asset`, `network`, `payTo` and `expiresAt`. Amounts are decimal strings, never floats.
- `settle(quote, proof, signal?)` returns exactly one of `succeeded`, `pending`, `failed` (with `retryable`) or `cancelled`. It must honour `AbortSignal` and must not retry unboundedly.
- `privacyNote` is shown to users verbatim. It must describe what the adapter actually does, verified against primary sources. A transparent transfer is not "private"; a simulated swap is not a payment.
- `mode` is `test` or `live`. Test-network adapters must say `test`.

## Rules

- Never accept, request or store seed phrases or private keys. The payer signs in their own wallet.
- `payTo` comes from server configuration (an env var you document by name), never from request input. No default payout address.
- Do not change the interface without the code owner's review. If x402/Zcash needs a different shape, propose the change in the PR description.
- Follow the feasibility findings on 49TH-12. Do not implement a route that issue did not verify.

## File ownership for the adapter work (49TH-13)

You may add or edit:

- `src/payments/adapters/<adapter-id>.ts` and `src/payments/adapters/<adapter-id>.test.ts`
- `api/pay/*.ts` for the adapter's HTTP endpoints
- one entry in the `ADAPTERS` map in `src/payments/registry.ts`
- new variable names in `.env.example` and the README configuration table
- dependencies in `package.json` needed by the adapter

Everything else (page, styles, redactor, terminal, `types.ts`) belongs to the site owner. Push a branch; the code owner reviews, opens the PR and wires any UI.

## Definition of done

`npm run check` and `npm run test:e2e` pass. Unit tests cover quote, success, failure, cancellation and abort. `GET /api/status` reports the new adapter when `PAYMENT_ADAPTER` selects it.
