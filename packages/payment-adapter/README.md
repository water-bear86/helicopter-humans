# @helicopter-humans/payment-adapter

Verify-only client for the CipherPay x402 v2 Zcash `exact` scheme: the buyer
sends shielded ZEC directly to our unified address, and we ask CipherPay
whether it arrived.

Zero dependencies, Node 24 ESM, `node --test`. Hand-written `types/index.d.ts`
so the site's TypeScript stack can import it without a build step.

```js
import { createPaymentAdapter, InMemoryReceiptLedger } from '@helicopter-humans/payment-adapter'
```

## What this package does and does not do

Does: build a server-owned expiring challenge, parse a bounded
`PAYMENT-SIGNATURE` envelope, compare it against that challenge, call
`POST /api/x402/v2/verify`, and grant a resource at most once per txid through
an injected ledger.

Does **not**: broadcast a transaction, create or hold a wallet, accept a seed
phrase / spend key / viewing key, swap an asset, call `/settle`, sponsor a
fee, or move funds in any direction. The buyer has already paid on the Zcash
network before we are asked anything. We are reading a receipt.

> **No live paid route yet.** `adapter.readyForLivePaidRoute` is `false` and
> stays false while `INTEGRATION_BLOCKERS` is non-empty. See
> [Payer binding](#payer-binding-the-blocking-gap).

## Configuration

Variable names only. No value in this repository is a credential.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `CIPHERPAY_API_KEY` | yes | — | Merchant key. Sent only as a bearer header, never logged. |
| `ZCASH_PAYTO_UA` | yes | — | Unified address (`u1…`) with a shielded receiver. A `t1`/`t3`/`zs1` address is refused. |
| `ZCASH_PRICE_ZATOSHIS` | yes | — | Integer zatoshis. A float, `1e5` or `0` is refused. |
| `CIPHERPAY_FACILITATOR_URL` | no | `https://api.cipherpay.app` | `https`, or a loopback host for a local fixture. |
| `CIPHERPAY_NETWORK` | no | `zcash:mainnet` | The only value the hosted facilitator advertises. |

`resolveConfig` returns `mode: 'disabled'` with a `problems` array whenever
anything required is missing or wrong. **An unconfigured deployment has no
paid route** — it does not have a half-working one.

`mode: 'live'` means the hosted facilitator. `mode: 'test'` means a loopback
fixture server under our own control — it is **not** a provider testnet.
CipherPay does not operate one: `GET /api/x402/supported` returns exactly
`{x402Version: 2, scheme: "exact", network: "zcash:mainnet"}`.

## Request/response contract

### 1. No payment presented

`authorize` returns `kind: 'payment_required'`, `httpStatus: 402`, and both
the `PaymentRequired` object as `body` and its base64 in a `PAYMENT-REQUIRED`
header:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://<host>/api/v1/privacy-check", "description": "…", "mimeType": "application/json" },
  "accepts": [{
    "scheme": "exact",
    "network": "zcash:mainnet",
    "asset": "ZEC",
    "amount": "100000",
    "payTo": "<ZCASH_PAYTO_UA>",
    "maxTimeoutSeconds": 120,
    "extra": {}
  }]
}
```

`amount` is integer zatoshis as a decimal string, always. It comes from
`ZCASH_PRICE_ZATOSHIS`; `100000` (0.001 ZEC) appears in the tests as a
**fixture**, not as an approved production price.

### 2. Buyer retries with proof

The client broadcasts one **fully shielded** transaction and retries with
`PAYMENT-SIGNATURE` set to base64 of:

```json
{
  "x402Version": 2,
  "accepted": { "…the same requirements object…" },
  "payload": { "txid": "<64 hex>" }
}
```

`accepted` must match our challenge on `scheme`, `network`, `asset`, `amount`,
`payTo` and `maxTimeoutSeconds`. A lower price or a different destination is a
mismatch, not a negotiation. Our own requirements are what reach the
facilitator; the client's copy is compared and then discarded.

### 3. Outcomes

`authorize` returns exactly one of six kinds, each with `httpStatus`,
`headers`, `body`, a buyer-safe `buyerMessage` and an operator-only `detail`.

| kind | status | headers | meaning |
|---|---|---|---|
| `disabled` | 503 | — | No usable configuration. |
| `payment_required` | 402 | `PAYMENT-REQUIRED` | No proof presented. |
| `pending` | 202 | `Retry-After` | Proof presented, not verifiable yet. Retry the **same** txid. |
| `rejected` | 402 | — | This payment does not satisfy these requirements. |
| `verified` | 200 | `PAYMENT-RESPONSE` | Verified, and this request holds the receipt. |
| `upstream_error` | 503 / 504 | — | Our problem or the facilitator's. Says nothing about the buyer's payment. |

Two deliberate choices about not asking for money twice:

- **`pending` is 202, not a second 402**, and carries no `PAYMENT-REQUIRED`
  header. Re-quoting a payment that is already on-chain is how a buyer pays
  twice. The body sets `retryWithSamePayment: true`.
- **A fresh challenge goes out only for `missing_payment_header`.** A
  malformed, oversized, wrong-version or bad-txid header may sit on top of a
  payment that was already broadcast, so those are `rejected` with no new
  quote. A buyer who wants a new quote requests the resource with no header.

`upstream_error` distinguishes our failures from the buyer's. These reasons set
`operatorFacing: true` and `operatorActionRequired: true`, and their
`buyerMessage` says the payment was *not assessed*:

| reason | what it means |
|---|---|
| `merchant_unauthorized` | Our API key. |
| `merchant_billing_blocked` | Our CipherPay bill. |
| `ledger_unavailable` | The receipt ledger did not answer. |
| `ledger_contract_violation` | The injected ledger broke its contract (e.g. dropped `resource`). |
| `quote_not_issued` | The challenge does not carry our mac over its own terms. |
| `challenge_config_drift` | Its scheme, asset, amount, destination or network is not the configured one. |

Render `buyerMessage`, never `detail`.

An expired quote is `rejected` with `quote_expired`, and its `buyerMessage`
tells the buyer to ask for a fresh quote and **re-send the same transaction
id** — the payment may already be on chain, and expiry is caught before the
ledger claim, so that same txid still settles the new quote. One residual edge:
a payment that was already claimed and left `pending` when its quote expired
will come back `txid_already_claimed` under a new quote id. That fails closed
and needs an operator to resolve it by hand; it never grants twice.

`PAYMENT-RESPONSE` decodes to `{success, txid, network}` — a verification
confirmation, not a settlement receipt. Nothing moved because of our request.

## Quote ids are signed

`settle(quote, proof)` receives the quote back from the caller, and a
serverless deployment has nowhere to remember the quotes it issued. Comparing
the money fields against configuration is not enough on its own: **every** quote
this server issues carries the same amount, destination and network, so a quote
we never issued — or one of ours with `expiresAt` moved into 2099, or
`productId` swapped for a dearer one — would pass that check unchanged.

So the quote id *is* the signature. `quoteId` is `<nonce>.<mac>`, where the mac
covers the product, the resource, the scheme, the network, the asset, the
amount, the destination, `maxTimeoutSeconds` and `expiresAt`. Change any of them
and the mac stops matching. `authorize` and `settle` both check it before the
ledger is touched, so a quote we will not honour never reserves a txid.

The site's `Quote` shape is unchanged — no new field for a consumer to drop.
**Treat `quoteId` as opaque:** do not parse it, do not build one by hand, and do
not regenerate a `Quote` field by field before handing it back to `settle`.

`createdAt` is deliberately *not* signed: the site's `Quote` does not carry it,
so `settle` could not reproduce it. Nothing is decided on it — expiry reads
`expiresAt`.

The signing secret comes from `quoteSigningSecret`, or is derived from
`CIPHERPAY_API_KEY` when that is omitted. Derived means rotating the API key
invalidates quotes still in flight; they fail closed, and the window is one
quote TTL (300s). Set `quoteSigningSecret` explicitly to survive a rotation, and
give every instance serving the route the same value.

This is **not payer binding.** The mac proves *we* issued these terms. It says
nothing about who paid — see "Payer binding: the blocking gap" below.

## Receipt ledger

The facilitator does not solve replay for us. `verify_core_v2` returns
`isValid: true` for an already-verified txid whenever the stored amount still
covers the quote, and `@cipherpay/x402` does not apply `rejectReplays` on the
v2 path. So one txid grants exactly one request, and **we** remember that.

Inject a ledger implementing `ReceiptLedger`:

```
claim({network, merchantId, txid, requestId, amountZatoshis, resource})
  -> {status: 'acquired' | 'owned' | 'taken', record}
settle({...claim, state: 'granted' | 'rejected', outcome}) -> record
get({network, merchantId, txid}) -> record | undefined
durable: boolean
```

- `acquired` — first claimant. Verify.
- `owned` — same `requestId` **and** same `amountZatoshis` **and** same
  `resource`. A retry: return the stored terminal result, or re-verify if still
  `claimed`.
- `taken` — anything else: another request, the same request re-priced, or the
  same request now asking for a different resource. Grant nothing.

`resource` is **stored on the record and compared**, not merely passed through.
One txid grants one request *and* one resource; without the comparison, a
request id reused across two resources replays one payment into both. The
record your `claim` returns must carry `resource` back — the adapter re-checks
it and answers `ledger_contract_violation` (503, nothing granted) if it is
missing, so a ledger that drops the column fails closed rather than quietly
granting twice.

The resource is deliberately **not** part of the primary key: a second resource
has to collide with the first record and lose, not open a second row.

`pending` and `upstream_error` leave the record `claimed`, so the owning
request can retry the same txid and nobody else can take it meanwhile. If the
payment verifies but `settle` fails, the adapter **fails closed** and grants
nothing: a grant without a receipt is how one txid buys twice.

`claim` **must be atomic** — one conditional insert, not a read then a write:

```sql
CREATE TABLE payment_receipt (
  network         TEXT NOT NULL,
  merchant_id     TEXT NOT NULL,
  txid            TEXT NOT NULL,
  request_id      TEXT NOT NULL,
  amount_zatoshis TEXT NOT NULL,
  resource        TEXT NOT NULL,
  state           TEXT NOT NULL,
  outcome         JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (network, merchant_id, txid)
);

-- 'acquired' when this inserts a row; otherwise read the row back and compare
-- request_id, amount_zatoshis AND resource to decide 'owned' vs 'taken'.
INSERT INTO payment_receipt (network, merchant_id, txid, request_id, amount_zatoshis, resource, state)
VALUES ($1, $2, lower($3), $4, $5, $6, 'claimed')
ON CONFLICT (network, merchant_id, txid) DO NOTHING
RETURNING request_id, amount_zatoshis, resource;
```

`InMemoryReceiptLedger` declares `durable: false`, and
`createPaymentAdapter` throws `UnsafeLedgerError` for it unless you pass
`allowEphemeralLedger: true`. **Tests and local development only.** A Vercel
instance's memory or filesystem is not a shared ledger: two instances would
each grant a resource for the same txid.

`merchantId` defaults to a SHA-256 prefix of the API key, so the ledger never
stores the key. Rotating `CIPHERPAY_API_KEY` therefore changes the scope and
old records stop matching — pass an explicit `merchantId` if you rotate keys
and want replay protection to survive the rotation.

## Amount enforcement, honestly

CipherPay applies `SLIPPAGE_TOLERANCE = 0.995`: it accepts a payment up to
**0.5% short** of the quoted amount. This is not strict exact-amount
enforcement, and we cannot tighten it — the v2 verify response is
`{isValid, invalidReason?, payer?}` and **carries no received amount**, so
there is nothing for us to re-check. `providerMinAcceptableZatoshis` exists to
document the tolerance, not to enforce it.

`payer` is always `null`: the sender's Zcash address is never revealed to us.

The v2 verifier also does **not** check that the decrypted note was addressed
to the `payTo` string we sent — any note decrypting to the merchant viewing
key counts. With a single merchant key that is tolerable only because we bind
the txid ourselves in the ledger.

Mempool presence is enough for the verifier; there is no confirmation-depth
check. Zero-conf is the product at a micropayment price. Do not reuse this for
large amounts.

## Refunds

The payment is already on-chain before we verify anything. Cancellation cannot
undo it, and there is no automatic refund: the per-request payload has no
refund address. A refund is possible only by hand, from the operator wallet,
and only if the buyer left a shielded return address in the memo. `PRIVACY_NOTE`
says so, and any page copy must too.

## Payer binding: the blocking gap

**A public txid alone does not prove that its submitter paid.** The v2 verify
endpoint has no challenge, memo or caller binding. Anyone who observes a txid
can present it, and the receipt ledger stops *replay* but not *first-claim
theft* — whoever presents a valid txid first gets the resource, payer or not.

`requestId` is a locally generated correlation id. `quoteId` carries a mac over
the *terms we quoted* (see "Quote ids are signed"), which proves those terms are
ours and nothing more. Neither is cryptographic payment ownership, and neither
must ever be described as such.

`INTEGRATION_BLOCKERS` carries this and three other gaps as data, and
`readyForLivePaidRoute` stays `false` until they are empty:

1. `no_payer_binding` — the above.
2. `no_end_to_end_payment` — no shielded payment verified end to end. Hosted
   discovery and the 401 gate were exercised on 2026-09-30; Ironwood
   decryption is in published source, not proven on the deployed host.
3. `no_confirmed_payer` — `@cipherpay/zipher-cli@0.3.0` predates Ironwood
   activation, and `@x402/fetch` will not construct a `zcash:mainnet` payment.
4. `no_durable_ledger_deployed` — see above.

Verify any proposed binding against primary sources before clearing (1).

## Privacy claims

`PRIVACY_NOTE` is shown to users verbatim and claims only what 49TH-12
verified: the public chain hides sender, receiver and amount; CipherPay and we
learn the amount and that a payment arrived, not the sender's address; the IP
and HTTP request are outside Zcash; refunds are manual only.

Not claimed anywhere, and not to be added: "the buyer reveals nothing",
"x402 payments are private", "nobody can see the payment", Foundation support,
an audit badge, or calling a swap or a transparent transfer shielded. The
Zcash `exact` scheme is a third-party proposal, not a Foundation scheme —
`@x402/core` clients will ignore `zcash:mainnet`.

## Logging

The API key appears in exactly one place: the `authorization` header in
`facilitator.js`. It is never logged, never returned in an outcome and never
placed on the adapter surface. The optional `logger` receives only
`{event, attempt, status, txid}`; no credentials, payment headers, viewing
keys or raw request bodies. Show `buyerMessage` to buyers and keep `detail`
for operator logs.

## Bounds

| Bound | Default | Option |
|---|---|---|
| `PAYMENT-SIGNATURE` header | 8192 bytes | `limits.maxHeaderBytes` |
| Decoded envelope | 8192 bytes | `limits.maxEnvelopeBytes` |
| Verify response body | 65536 bytes | `facilitatorOptions.maxResponseBytes` |
| Per-attempt timeout | 10000 ms | `facilitatorOptions.attemptTimeoutMs` |
| Verify attempts | 3 | `facilitatorOptions.maxAttempts` |
| Challenge lifetime | 300 s | `quoteTtlSeconds` |
| `maxTimeoutSeconds` | 120 | `maxTimeoutSeconds` |

Retries re-verify the same txid and only for a transport error, a timeout, or
HTTP 408/425/429/5xx. 400/401/402 are never retried. An aborted `AbortSignal`
stops further attempts immediately, including during backoff.

## Usage

```js
import { createPaymentAdapter } from '@helicopter-humans/payment-adapter'

const adapter = createPaymentAdapter({ env: process.env, ledger: myDurableLedger })

if (adapter.mode === 'disabled') {
  // adapter.configProblems says exactly what is missing.
}

// Issue and store a challenge, keyed by quoteId.
const challenge = adapter.createChallenge({
  resource: { url: 'https://example.com/api/v1/privacy-check', description: 'One shielded privacy check' },
})

// On the retry, look the challenge up by quote id -- never rebuild it from
// request input -- and authorize.
const outcome = await adapter.authorize({
  challenge,
  paymentSignatureHeader: request.headers['payment-signature'],
  requestId: challenge.quoteId,
  signal: request.signal,
})

response.status(outcome.httpStatus)
for (const [name, value] of Object.entries(outcome.headers)) response.setHeader(name, value)
```

`quote()` and `settle()` are also provided, shaped to the site's
`PaymentAdapter` contract in `src/payments/types.ts`. `settle` accepts either a
bare 64-hex txid or a full `PAYMENT-SIGNATURE` value. It re-checks the quote's
money fields against current configuration **and** verifies the mac in its quote
id, so it only ever honours a quote this server issued, with the product and
expiry it issued. Hand the `Quote` object back as you received it — see "Quote
ids are signed". `fee` is `"0"`: this adapter charges the payer nothing of its
own. The payer separately pays a Zcash network fee we do not quote
([ZIP 317](https://zips.z.cash/zip-0317)), and CipherPay bills the merchant
separately (source default `FEE_RATE=0.01`; the hosted schedule is
unconfirmed).

## Tests

```bash
cd packages/payment-adapter && npm test
```

137 tests, no network, no dependencies. Covered: challenge schema and expiry;
missing / malformed / oversized / wrong-version / bad-txid headers; changed
requirements including a client-supplied lower price; expired quote and its
buyer copy; a valid fixture; pending detection; underpaid and rejected
responses; 400 / 401 / merchant-billing / 5xx / unparseable-response handling;
timeout and cancellation; concurrent and replayed txids; same-request retry;
price-tier reuse; and the unsafe and unconfigured storage cases.

Specifically for the grant boundary: a quote with a rewritten `expiresAt`, a
second `productId` on one quote id, a quote object `quote()` never returned, and
a quote signed by another secret all fail closed without reaching the
facilitator; a `scheme` or `asset` that drifted from configuration is an outcome
rather than an exception and reserves no txid; an owned replay pointed at a
different resource is `taken`, not `verified`; and a ledger that drops the
`resource` column is refused.

Every fixture is invented locally and labelled as such in
`test/helpers/fixtures.js`. No mainnet transfer, no paid API account, no
network call.

## Sources

- Scheme proposal: [`docs/scheme_exact_zcash.md`](https://github.com/atmospherelabs-dev/cipherpay-x402/blob/main/docs/scheme_exact_zcash.md)
- Verifier source: [`src/api/x402.rs`](https://github.com/atmospherelabs-dev/cipherpay-api/blob/main/src/api/x402.rs)
- Feasibility evidence and the claim list: 49TH-12

The deployed binary at `api.cipherpay.app` was not proven by a funded payment.
Where the proposal and the source disagree, this package follows the source
and says so.
