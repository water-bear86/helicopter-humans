# CipherPay testnet sandbox check (operator runbook)

This runbook exercises the accepted invoice checkout against CipherPay's hosted **testnet** sandbox. It uses the real order service, state machine, CipherPay client and PostgreSQL store.

It moves no real money. It cannot create a mainnet invoice: the harness is pinned to the testnet origin and to `utest1` addresses, and its database refuses mainnet invoice addresses. A passing testnet run does **not** clear any checkout blocker. `no_authorized_mainnet_e2e` needs its own explicitly authorised, capped mainnet payment, and `no_confirmed_payer` needs a mainnet payer shown to spend fully shielded.

## What was established (30 September 2026)

| Fact | Source | Status |
| --- | --- | --- |
| Testnet API origin `https://api.testnet.cipherpay.app`, dashboard `testnet.cipherpay.app` | cipherpay.app/en/docs/sandbox, /en/docs/api-ref | Documented. `GET /api/health` answered `{"service":"cipherpay","status":"ok"}`, and so did this repo's preflight |
| Testnet is a separate server with separate accounts. A key only works on the server that issued it | cipherpay-api `src/config.rs` (`NETWORK`), sandbox docs | Documented and in source |
| Keys are `cpay_sk_` on both networks, with no test prefix | cipherpay-api `src/api_keys/mod.rs` | Source. The origin, not the key, is what separates the networks |
| Invoice addresses are per-invoice Unified Addresses, `utest1…` on testnet | sandbox docs, `src/addresses.rs` | Documented and in source |
| `POST /api/invoices` and `GET /api/invoices/{id}` use the same handlers and shapes on both networks | `src/api/invoices.rs`, `src/invoices/mod.rs` at pinned `f6f022db` (still `main`) | Source |
| A fee recipient (`address.1`) exists whenever `FEE_ADDRESS`/`FEE_UFVK`/`FEE_RATE` are set, on either network | `src/config.rs` | Source. **Whether the hosted testnet sets them is unknown.** The harness rejects such a quote (`quote_rejected`), which would itself be a finding |
| Upstream checks `refund_address` for encoding only, not network | `src/validation.rs` | Source. This app validates refund addresses per network itself and never sends `refund_address` |
| Payment detection trial-decrypts Orchard | cipherpay-api `TESTNET_GUIDE.md` | The payer must send an Orchard-shielded spend |
| Testnet billing | billing docs are silent on testnet; docs and code disagree on the minimum fee | **Unknown.** Record what the testnet dashboard shows |
| `/.well-known/payment` names `https://testnet.api.cipherpay.app`, which does not resolve | `src/api/system.rs` | Upstream inconsistency. This app pins the documented origin and has no discovery or fallback. x402 discovery is not the invoice interface |
| Public testnet faucet | `faucet.zecpages.com`, named by CipherPay | **Not reachable** on 30 September. The operator needs another source of testnet ZEC |

## Code added for testnet (and only testnet)

- `CIPHERPAY_TESTNET_ORIGIN` and a `network` option on the client, service and fixture. Each network has one pinned origin, with no override and no fallback between them. A testnet client rejects `u1` invoice addresses, and a mainnet client rejects `utest1`.
- Refund addresses are checked for the order's network: `utest1`/`ztestsapling1` on testnet, `u1`/`zs1` on mainnet. Mainnet remains the default everywhere, and the hosted checkout routes are unchanged and still fail closed.
- `db/sandbox/0001_testnet_only.sql` makes a sandbox database accept only `utest1` invoice addresses. A production database keeps the mainnet-only check, so neither can hold the other's invoices.
- `src/sandbox/` holds the preflight, harness and CLI. `SANDBOX_OFFER` is a US$1.50 testnet offer (`approved: false`) that is never served by a route.

## Configuration

Server-side, local only. Put these in `.env.sandbox` (gitignored, read by `npm run sandbox`) or export them. Never commit them or paste them into an issue.

| Variable | Value |
| --- | --- |
| `SANDBOX_NETWORK` | exactly `testnet` |
| `SANDBOX_CIPHERPAY_API_KEY` | secret key from the **testnet** dashboard (`cpay_sk_…`). Must differ from `CIPHERPAY_API_KEY` |
| `SANDBOX_DATABASE_URL` | disposable sandbox database. TLS (`sslmode=require` or `verify-full`) unless loopback. Must differ from `CHECKOUT_DATABASE_URL` |
| `SANDBOX_DATABASE_IS_DISPOSABLE` | `yes`, set only by the operator for a throwaway database |
| `SANDBOX_ORDER_FILE` | optional. Default `.sandbox-local/order.json`, written with mode 0600, and holds the recovery code |

## Commands

```sh
npm run sandbox -- preflight              # read-only; exit 0 only if every check passes
npm run sandbox -- preflight --offline    # configuration only; always NOT READY
npm run sandbox -- create --confirm-testnet   # preflight again, then ONE testnet order + invoice
npm run sandbox -- refresh                # preflight again, then one provider read of that sandbox order
npm run sandbox -- check-tx < tx.json     # offline Orchard-only policy check of getrawtransaction output
```

The preflight checks, in order:

1. Local runtime, not hosted.
2. `SANDBOX_NETWORK=testnet`.
3. Key present and shaped, and not the production key.
4. Database URL present, TLS or loopback, and not the production URL.
5. Operator's disposable flag.
6. Only if 1 to 5 all pass: one read-only transaction on the database (5 s). It resolves the five checkout tables into one schema, and reads the catalog for every CHECK constraint on `checkout_invoices.payment_address`. There must be exactly one, it must be validated, and its definition (`pg_get_constraintdef`) must equal the one `db/sandbox/0001_testnet_only.sql` creates. The name is not trusted: a renamed mainnet constraint, a permissive check, a `NOT VALID` check or an extra address check is refused. The probe never inserts, migrates or writes.
7. Only if 6 passes: one unauthenticated `GET https://api.testnet.cipherpay.app/api/health`: 5 s overall, no redirects, body read up to 4096 bytes. A larger declared length is refused before reading, and a longer stream is cancelled at the limit.

It prints variable names and pass/fail, never values. Anything missing, skipped or failing makes it **NOT READY**. A step it did not run is reported `SKIPPED` with the reason, so the report says which resources were actually contacted: after a local refusal, neither the database nor the provider.

`create` and `refresh` both run this full preflight first, because both open the order store. When it is not ready, no store is opened. `refresh` reads and checks its order file (recovery code shape, `network: "testnet"`, sandbox offer version) before the preflight, so a missing or mislabelled file contacts nothing.

`refresh` then checks the order before any provider read or change:

- The order file must hold a well-formed recovery code, `network: "testnet"` and the sandbox offer version. The file's labels are only a first filter.
- The loaded order must be the sandbox offer and version. Any receipt must be for that offer, and every invoice address must be a testnet `utest1` address.

A mainnet preorder, or any other order, is refused whatever its file says. It gets no provider read, and its state and receipt are unchanged.

`create` refuses to run if an order file already exists: one attempt per file. It writes the recovery code to the 0600 file before requesting the invoice, and never prints it. It prints the testnet payment URI and an evidence JSON with state, amount, address, expiry, received amount and receipt, but no code, key or URL. There is no polling and no background process. Run `refresh` by hand.

## Disposable database

To set it up:

```sh
psql "$SANDBOX_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f db/migrations/0001_checkout_orders.sql
psql "$SANDBOX_DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f db/sandbox/0001_testnet_only.sql
```

A local container works for a first run:

```sh
docker run -d --name hh-sandbox-pg -e POSTGRES_PASSWORD=<local> -e POSTGRES_DB=hh_sandbox -p 127.0.0.1:55432:5432 postgres:17-alpine
```

Remove it afterwards with `docker rm -f hh-sandbox-pg`. Never point this at a customer or production database. The sandbox migration would refuse every mainnet invoice there.

## Operator checklist (non-secret facts go on the issue; secrets never do)

1. **Merchant.** Create the testnet merchant account on `testnet.cipherpay.app`. Record on the issue: the account exists, it is testnet, and who controls it.
2. **Viewing key.** Register only a testnet viewing key (`uviewtest…`/`uivktest…`), directly in the CipherPay dashboard. Never paste a seed, spending key, viewing key, API key or recovery code into Multica, this repository or an issue.
3. **Fees.** From the dashboard, record the account's actual fee rate and billing method. Also record whether the testnet account shows any fee recipient. The source defaults are not a quote. If the created quote has a second recipient, the harness rejects it; record that outcome rather than working around it.
4. **Key.** Create a secret API key in the testnet dashboard and put it in `.env.sandbox` only.
5. **Database.** Prepare a disposable database as above. Set `SANDBOX_DATABASE_IS_DISPOSABLE=yes`.
6. **Preflight.** Run `npm run sandbox -- preflight`. Attach the output: it contains no values.
7. **Wallet.** Prepare an operator-owned testnet wallet (below), funded with testnet ZEC.
8. **Create.** Run `npm run sandbox -- create --confirm-testnet` once. Pay the printed URI from the testnet wallet, using exactly that amount and memo and an Orchard spend, before the printed expiry.
9. **Refresh.** Run `npm run sandbox -- refresh` until the state is `payment_detected`, then `fulfilled`, or a terminal finding. Stop at confirmation or 40 minutes. Do not send a second payment for an unresolved one.
10. **Evidence.** Record:
    - wallet name and version
    - the evidence JSON
    - the public txid
    - the `check-tx` result
    - the fee shown by the wallet

## Operator-owned wallet path and fully shielded evidence

The operator runs the wallet on their own machine. This app never opens a wallet, sees key material or moves funds.

- **zingo-cli** (zingolabs/zingolib): `zingo-cli --chain testnet --data-dir <separate testnet dir>`. Use a data directory separate from any mainnet wallet. Send the whole invoice from Orchard funds with the invoice memo.
- **Zallet** (zcash/wallet, `0.1.0-beta.3`, beta): `z_sendmany` with `privacy_policy` `FullPrivacy` (its default). Many RPCs are not implemented yet.
- **Testnet funds:** CipherPay's named faucet was unreachable on 30 September. Getting testnet ZEC is an open operator step.

Pay from Orchard funds only. A payment that moves value between shielded pools (Sapling to Orchard, or back) reveals the amount crossing on chain (Zcash protocol specification; ZIP 318), so it does not meet this policy. A wallet holding only Sapling funds must first shield them into Orchard in a separate, earlier transaction.

### `check-tx`: an offline policy check

Fetch the public transaction as verbose JSON from a node or wallet the operator trusts (`getrawtransaction <txid> 1`, zcashd schema: https://zcash.github.io/rpc/getrawtransaction.html). Then run `npm run sandbox -- check-tx < tx.json`. It reports `orchard_only` (exit 0) only when all of these hold:

- It is a v5 (NU5) transaction: `version` 5, `overwintered` true, `versiongroupid` `26a7270a`. Orchard is active on both mainnet and testnet since NU5.
- `vin`, `vout` and `vjoinsplit` are present and empty: no transparent value and no Sprout.
- `vShieldedSpend` and `vShieldedOutput` are present and empty, and the Sapling balance is 0: no Sapling value. Every Sapling balance form present (`valueBalance` in ZEC, `valueBalanceZat`) must be well formed, zero and in agreement. Both absent counts as zero, because the v5 encoding omits `valueBalanceSapling` when there are no Sapling spends or outputs (ZIP 225).
- `orchard.actions` is non-empty, and every action field has its exact ZIP 225 width in lower-case hex: `cv`, `nullifier`, `rk`, `cmx` and `ephemeralKey` 32 bytes, `encCiphertext` 580, `outCiphertext` 80, `spendAuthSig` 64.
- The bundle carries the fields a non-empty Orchard bundle requires: `anchor` 32 bytes, `proof` exactly 2720 + 2272 × (number of actions) bytes, `bindingSig` 64 bytes.
- `orchard.flags.enableSpends` and `enableOutputs` are both true.
- `orchard.valueBalanceZat` is a positive integer. With nothing else moving value, it is the fee. `valueBalance` in ZEC, if present, must agree with it.

Contradictory or malformed data and any cross-pool transfer are `fail`. Incomplete data (a required field absent) is `unverified`, as is a transaction version it does not know: v6 and later, for example after a future network upgrade. Neither ever passes, and both exit 1. Field widths are structural checks only: proofs and signatures are not verified.

This checks the structure of a document and the privacy policy. It does not prove:

- that the transaction is in a block, or confirmed
- that the operator's wallet made it
- that it paid this invoice

Those come separately, and all are required:

- the provider's invoice record (the `refresh` evidence showing the amount received and confirmation)
- the operator's own wallet record of the send
- the txid being found by the operator's trusted node or the explorer `testnet.cipherscan.app`

A receiving address or a wallet's release notes alone prove none of this.

## After the testnet run

Testnet success is evidence that the integration and state machine work against the hosted provider. It is not mainnet payment evidence, and it does not clear any checkout blocker.

The mainnet test remains separate. It requires:

- approved commercial terms
- verified merchant and fees
- a deployed production store
- a mainnet payer
- Angus's explicit approval of the actual quote with bounds for principal, payer fee, provider liability and refund fee, one attempt and a finite deadline

Mika presents those. No configuration toggle enables collection.

## PostgreSQL deployment proposal (not provisioned)

**Recommendation:** Neon's free plan, as two separate Neon projects: `hh-checkout-sandbox` (disposable, testnet-only schema) and `hh-checkout-prod` (mainnet schema). Create them through the Vercel Marketplace integration on team `redemption-c64d16c8`, so billing stays on the existing Vercel account. Nothing has been created.

| Item | Proposal |
| --- | --- |
| Why Neon | Vercel Postgres moved to Neon (Dec 2024) and the Marketplace plan starts at $0. The team has no storage integration today. The one existing Supabase project (`check1`, us-east-2) belongs to other work and must not be reused |
| Isolation | One project per environment, one database per project, one role per app. No shared branches between sandbox and production |
| Region | Same as the Vercel functions (default `iad1`, Washington DC), so AWS `us-east-1` or the nearest Neon region. **Free-plan region availability is not confirmed**; confirm at creation |
| Free-plan limits (neon.com/docs/introduction/plans) | 0.5 GB storage per project, 100 CU-hours per project per month, up to 2 CU, 5 GB egress, 6 h (1 GB) history, scales to zero after 5 min and cannot be disabled |
| Cost | $0. Overage does not bill: writes fail when storage is full, and compute suspends when CU-hours or egress run out until the next period or an upgrade. **The operator must confirm the Marketplace plan shown at install is the $0 plan** |
| Retention | 6 h point-in-time history only, so there are no real backups on free. Before live collection, schedule a `pg_dump` of the five checkout tables to operator storage, or move production to a paid plan, **quote unresolved** |
| Roles | Owner role for migrations only, used by the operator from their machine. App role `hh_checkout_app` with `SELECT, INSERT, UPDATE` on the five `checkout_*` tables, no `DELETE` and no DDL (docs/CHECKOUT.md) |
| TLS and pooling | `sslmode=require` (the store refuses less). Functions use the `-pooler` host (PgBouncer, transaction mode), and each instance keeps at most three connections. Migrations use the direct host |
| Secrets | `CHECKOUT_DATABASE_URL` as an encrypted, server-only Vercel variable, Production only. Never `VITE_`-prefixed. The Marketplace's injected `DATABASE_URL`/`POSTGRES_*` variables should be removed or scoped away from functions that do not need them |
| Migration | Operator applies `0001_checkout_orders.sql` in one transaction to `hh-checkout-prod`. A second run fails and changes nothing. Sandbox also gets `db/sandbox/0001_testnet_only.sql` |
| Non-destructive verification | Against production, only read-only checks: tables present, the mainnet address constraint present and the testnet one absent (the sandbox preflight's probe run in reverse), and the app role has no `DELETE`. `npm run test:pg` creates and drops its own schema; run it against the **sandbox** project or a local container only, never production |

Free-tier alternative: a Supabase free project in the existing `49thparallel.io` organisation. It allows 500 MB and 2 active projects, pauses after a week of inactivity, has no automatic backups, and its transaction pooler is on 6543. The pausing makes it a poor fit for a checkout.
