# Invoice checkout (Founding Agent Pass preorder)

Collection is off. On every hosted deployment the checkout routes answer HTTP 503 `checkout_disabled`, whatever the environment contains. The only way to run the checkout is the local fixture: a simulated provider, fake unpayable addresses and an in-memory store.

This is the CipherPay **invoice** path recommended by 49TH-19. The txid/x402 path (`docs/PAYMENT_ADAPTER.md`, `/api/pay/*`) stays disabled and is not the checkout.

## What a receipt is, and is not

A receipt is a preorder entitlement for the Founding Agent Pass under the offer version stored on the order. It is not a working privacy service, a relay, an x402-to-Zcash swap or proof of who owns the paying wallet. CipherPay sees viewing information and order/payment metadata, and the host sees traffic to this app. Nothing here is anonymity from the merchant, provider or host.

## Where things live

| Piece | Path |
| --- | --- |
| Draft offer (versioned, `approved: false`) | `src/checkout/offer.ts` |
| Readiness blockers (code, not config) and mode gate | `src/checkout/readiness.ts`, `src/checkout/runtime.ts` |
| CipherPay invoice client: pinned origin, timeouts, size caps, strict parsing | `src/checkout/cipherpay.ts` |
| ZIP 321 payment URI check | `src/checkout/zip321.ts` |
| Order service (state machine, claims, fulfilment) | `src/checkout/service.ts` |
| Store contract and memory store (fixtures only) | `src/checkout/store.ts` |
| PostgreSQL store | `src/checkout/store-postgres.ts` |
| Migration | `db/migrations/0001_checkout_orders.sql` |
| Routes | `api/checkout/orders.ts`, `api/checkout/order.ts`, handlers in `src/checkout/http.ts` |
| Preview page | `checkout.html`, `src/checkout-page.ts` |
| Simulated provider | `src/checkout/fixture-cipherpay.ts` |

The free redactor does not import or call any of this. An e2e test checks that using it makes no `/api/` request.

## Upstream contract (pinned `f6f022db1f6754b4cd74fea2275f040ec14d557b`)

- `POST /api/invoices` with `Authorization: Bearer <merchant key>`. We send only `product_name`, `amount` (from integer cents: 900 becomes `9`) and `currency: "USD"`, all server-owned. We never send `refund_address`.
- The create response has **float** `price_zec` and no integer amount. We do not invent one.
- `GET /api/invoices/{id}` is public and returns integer `price_zatoshis` and `received_zatoshis`. Integers are parsed with a source-text check, so a value that does not round-trip exactly (beyond 2^53, `639722.0`, exponent form) is rejected.
- `zcash_uri` is `zcash:<addr>?amount=..&memo=..`, or with a provider fee, `zcash:?address=..&amount=..&memo=..&address.1=..&amount.1=..&memo.1=..`.

## Order flow

1. `POST /api/checkout/orders` creates an order in state `new` and returns a recovery code once (`hhr_` + 32 random bytes, base64url). The store keeps only its SHA-256.
2. `POST /api/checkout/order {"action":"create_invoice"}` takes a durable **creation claim** (state `creating_invoice`, claim token and 30 s expiry), then calls the provider outside any transaction.
   - Created: the invoice is bound to the order (`quote_unverified`). It becomes payable only after the provider's GET confirms: status `pending`, zero received, USD 9, same `price_zec`, `round(price_zec × 1e8) == price_zatoshis` (upstream's own formula), same expiry, and a URI with exactly one recipient (our address), exactly that amount and our memo. The URI shown is rebuilt from those validated values.
   - 400, 401, 402, 403, 404 or 422 (statuses upstream returns before inserting anything): nothing was created; the order returns to its previous state and a retry is safe.
   - Any other status (including 408/499 from a proxy), timeout, network error, oversized or malformed body: the outcome is unknown, so the order moves to `reconciliation_required`. No second invoice is created automatically.
   - A claim that is never released (crash) becomes `reconciliation_required` on the next access after its expiry.
   - An ordinary retry returns the existing invoice. Concurrent retries get 409 `invoice_creation_in_progress` while the claim is held.
3. `refresh` reads each of the order's invoices once (at most three), with the client timeout. There is no polling loop, no background process and no webhook in this slice. Every read is rechecked against the order's stored terms (currency, fiat amount) and the invoice's original `price_zec`, integer amount and URI; any change moves the order to `reconciliation_required` and revokes a receipt. A later change of the global offer never reinterprets an existing order.
4. `new_quote` replaces an `expired` zero-paid or `quote_rejected` quote. It is a deliberate buyer action, never a retry side effect. There are at most three quotes per order, all under the order's own offer version. Before claiming, it reads every earlier invoice, rejected quotes included, outside any transaction, then applies those reads and rechecks the locked order in the claim's transaction. If any read is unavailable or missing, or any earlier invoice shows money or no longer adds up, no invoice is created and no payable details are returned. A rejected quote is never made payable and its fee recipient is never stripped, but money arriving on it is recorded (`needs_resolution`, `payment_on_rejected_quote`) so the buyer can request a refund with the recovery code. A zero-paid rejected quote that reads cleanly may be replaced.
5. `cancel` is allowed only before anything has been received.
6. `request_refund` records a checksummed shielded mainnet address (`u1…` Bech32m or `zs1…` Bech32) for an order that has received ZEC. It is authenticated only by the recovery code. The same transaction revokes any receipt and moves the order to `needs_resolution` (`refund_requested`): asking for the money back gives up the preorder. The provider's public write-once refund-address endpoint is never used as ownership proof. Refunds are manual from the operator wallet, and no key enters this app.

Every action names only itself. Requests carrying `invoiceId`, `memo`, `txid`, `orderId`, amounts or any other field are refused with 400.

## States

| State | Meaning | Payable details shown |
| --- | --- | --- |
| `new` | Order exists, no invoice | no |
| `creating_invoice` | Claim held | no |
| `quote_unverified` | Created; integer amount and URI not yet validated | no |
| `awaiting_payment` | Validated, until expiry | **yes**, while unexpired |
| `payment_detected` | Provider saw it in the mempool | no |
| `fulfilled` | `confirmed` with received ≥ quoted, receipt written once | no |
| `expired` | Expired with nothing received; a new quote may follow | no |
| `quote_rejected` | Failed our checks before display (for example an extra fee recipient) | no |
| `needs_resolution` | ZEC arrived in a way we will not grant automatically (underpaid, partial, confirmed below quote, paid after expiry or cancel, paid on a replaced quote), or the buyer requested a refund | no |
| `reconciliation_required` | Provider outcome unknown or inconsistent (price, URI or identity changed, unknown status, invoice missing) | no |
| `quarantined` | Its txid is already bound to another order | no |
| `cancelled` | Buyer cancelled before any payment | no |
| `refunded` | Provider marked the invoice refunded; any receipt is revoked | no |

`needs_resolution`, `reconciliation_required`, `quarantined` and `refunded` are not left by a provider read, only moved to something more severe; an operator resolves them. A provider read older than what is stored (lower received amount or earlier status, from two refreshes racing) is ignored. A fulfilled order moves only for a provider refund or a more severe finding, and its receipt is then revoked. The page never tells a buyer who may have paid to pay again.

### Payment timing

The deadline shown to the buyer is the provider's `expires_at` at creation, stored as `quote_expires_at` and never changed. Upstream legitimately extends `expires_at` when its scanner detects a payment (+30 min) or records an underpayment (+10 min); that value is kept separately as `provider_expires_at` and never shown or used for timing. An unpaid `pending` invoice whose `expires_at` moved is `reconciliation_required`.

A payment is on time when the provider's `detected_at` is at or before `quote_expires_at`. It may confirm later (`confirmed_at` after the deadline) and still grants. A payment detected after the deadline goes to `needs_resolution` (`payment_after_expiry`) on every read, whether or not anyone refreshed while the quote expired. A detected or confirmed invoice without a `detected_at`, or confirmed without a consistent `confirmed_at`, goes to `needs_resolution` (`payment_timing_unknown`) for an operator. There is no grace period for scanner lag: a payment broadcast just before the deadline but detected after it is reviewed manually.

A multi-payment invoice is legitimate: each txid the provider reports is claimed for that order without quarantine, and the invoice is granted when the provider confirms the full amount. If a partial payment was observed first, the order is already in `needs_resolution` and stays there for the operator. A txid already claimed by another order quarantines the second order. Upstream confirms at 99.5% of the price; we grant only at 100% and send anything less to `needs_resolution`.

## Security properties

- The credential travels only in `Authorization: Bearer`, never in a URL, cookie, body or storage. The page keeps it in memory. The browser never attaches it on its own, and state-changing requests must also be same-origin JSON (`Origin` equals the request origin, `Sec-Fetch-Site` not cross-site).
- Responses send `Cache-Control: no-store`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`. The page sets `<meta name="referrer" content="no-referrer">` and `noindex`.
- Unknown and malformed codes both return 404 `order_not_found`. Provider invoice ids, memo codes and txids are public metadata and are never accepted as authority.
- The provider origin is pinned to `https://api.cipherpay.app`. Only the fixture may use an http loopback origin. The operator-run testnet harness (`docs/SANDBOX_TEST.md`) selects `network: 'testnet'`, which pins `https://api.testnet.cipherpay.app` and `utest1` addresses instead; there is no fallback between networks, and the routes always use mainnet. Requests use `redirect: "error"`, an 8 s timeout and a 32 KiB response cap. Invoice ids are checked as UUIDs before they are placed in a path.
- Nothing logs request data, codes or provider responses.
- Rate limiting is not implemented. Add it at the edge before enabling.

## PostgreSQL store

`PostgresOrderStore` runs every state change in one transaction holding `SELECT … FOR UPDATE` on the order row, and never holds a transaction across a provider call. Uniqueness is enforced by the schema as well as by the code:

- `checkout_invoices.provider_invoice_id` primary key and `payment_address` unique: one invoice binding per order.
- `checkout_receipts.order_id` and `provider_invoice_id` unique: at most one receipt per order and per invoice.
- `checkout_payment_txids.txid` primary key: one owning order per txid, claimed with `INSERT … ON CONFLICT DO NOTHING` inside the order transaction.
- `checkout_refund_requests.order_id` unique.
- A check that a creation claim exists if and only if the state is `creating_invoice`, and that a payable URI exists only alongside a validated integer amount.

Constraint and serialization failures surface as `StoreConflictError` (409, nothing committed). Connection, timeout and server failures surface as `StoreUnavailableError` (503). No provider call is made when the claim cannot be written.

Apply the migration once, in a transaction, to an isolated database approved for this app. A second run fails and changes nothing:

```sh
psql "$CHECKOUT_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f db/migrations/0001_checkout_orders.sql
```

Use a dedicated least-privilege role: `SELECT, INSERT, UPDATE` on the five `checkout_*` data tables, with no `DELETE` and no DDL. Non-loopback URLs must set `sslmode=require` or `verify-full`, or the store refuses them. Point serverless functions at a pooled endpoint; each instance keeps at most three connections.

No database has been provisioned. Do not create a paid one or reuse an unrelated one for this.

## Configuration (for later; nothing reads these today)

| Variable | Scope | Notes |
| --- | --- | --- |
| `CHECKOUT_MODE` | server | `fixture` locally. `live` is read only once every blocker is removed in code. |
| `CIPHERPAY_API_KEY` | server secret | Merchant key. Encrypted deployment config only; never `VITE_`-prefixed, never in the repo or issues. |
| `CHECKOUT_DATABASE_URL` | server secret | Dedicated role on the isolated database, TLS required. There is no memory or filesystem fallback: `liveCheckoutFromEnv` throws without it. |

Webhooks are deferred. When added, the webhook secret is another server-only variable.

## Readiness blockers

`CHECKOUT_BLOCKERS` in `src/checkout/readiness.ts`. `/api/status` reports them under `checkout`. Each is removed only by the change that supplies its evidence:

| Id | Cleared by |
| --- | --- |
| `offer_not_approved` | Angus approving the price, credit and refund terms. Then publish a new offer version with `approved: true`. |
| `merchant_fee_config_unverified` | Merchant account, receiving wallet ownership and actual fee rate confirmed in the dashboard, with no buyer fee recipient. The URI check keeps rejecting `address.1` until a reviewed policy says otherwise. |
| `durable_store_not_deployed` | The migration applied to an approved isolated database, and `npm run test:pg` passing against it. |
| `no_confirmed_payer` | A released wallet shown to pay one of these invoices with a fully shielded spend. |
| `no_authorized_mainnet_e2e` | The capped, explicitly authorized mainnet test from the offer notes, recorded without keys or recovery codes. |

`resolveCheckout` returns `disabled` while any blocker exists. `fixture` is refused whenever `VERCEL`, `VERCEL_ENV` or `NODE_ENV=production` is set. An environment variable can neither clear a blocker nor claim one is satisfied.

## Tests

- `src/checkout/test-support.ts`: one service contract (isolation, retries, ambiguous creates, abandoned claims, fee recipient, amount mismatch, underpayment, multi-payment, late payment with and without a missed expiry refresh, on-time payment confirmed after the deadline, missing payment timestamps, moved pending deadline, changed fiat/currency/floating price after display, changed global offer, replacement blocked by an unreadable, missing, changed or paid earlier invoice including rejected quotes one and two quotes back, cancel, txid reuse, provider refund, store outage). It runs against the memory store (`service.test.ts`) and real PostgreSQL (`store-postgres.test.ts`).
- `src/checkout/store-postgres.test.ts` also checks the schema constraints directly, races two orders for one txid across connections, runs the migration twice, and maps store errors. It needs a disposable server:

  ```sh
  docker run -d --name hh-pg -e POSTGRES_PASSWORD=hhtest -e POSTGRES_DB=hh_test -p 127.0.0.1:55432:5432 postgres:17-alpine
  CHECKOUT_PG_TEST_URL=postgres://postgres:hhtest@127.0.0.1:55432/hh_test npm run test:pg
  ```

  Without `CHECKOUT_PG_TEST_URL` these tests are reported as skipped, not passed.
- `src/checkout/routes.test.ts`: disabled with a complete production environment (no fetch, no address, no `PAYMENT-REQUIRED`), fixture refused on hosts, public identifiers grant nothing, same-origin checks, and a store outage returning 503 with no provider call.
- `src/checkout/cipherpay.test.ts`, `zip321.test.ts`: origin pinning, classification, integer safety and URI rejection cases.
- `e2e/checkout.spec.ts`: keyboard and mobile flows against the fixture dev server.
- `npm run smoke:functions` after `vercel build`: the emitted functions stay 503 with a full environment and make no network call, and the fixture chain resolves inside the traced bundle.
