# z402 sprint handoff — for Codex

> Written by Hermes, 2026-09-29. This is a state-of-play document, not a task
> list with instructions. It exists so the next agent (or the next session of
> this one) does not have to re-derive the project state from the git history.
>
> **Read these three first, in order:**
> 1. This file
> 2. [`docs/Z402_THESIS_CORRECTIONS.md`](Z402_THESIS_CORRECTIONS.md) — the privacy claim
> 3. [`docs/Z402_MVP_PRD.md`](Z402_MVP_PRD.md) — the sprint scope

## What this project is

`helicopter-humans` — "A privacy layer for your agent. Don't be a helicopter
human." Public repo, 12 merged PRs, default branch `main`.

Two tracks, both live:

**Track 1 — `expose402`, shipped.** A free local Node CLI, published to npm as
`expose402@0.1.0`. It discovers saved payment traces in agent history (LangGraph
SQLite layouts) and removes whole selected threads, behind a typed confirmation
gate. Zero runtime dependencies, no network calls. Its archive SHA-256 is
published at `https://helicopter-humans.vercel.app/traces-sha256.json`.
Docs: `docs/PAYMENT_TRACE_CLEANER.md`, `packages/traces/README.md`.

**Track 2 — z402, in progress.** Private agent payments over native shielded
Zcash. See the sprint scope below. Code: `packages/z402/`, `tools/z402-wallet/`,
`docs/Z402_RUNBOOK.md`.

There is also an archived prototype — the CipherPay invoice checkout and a
`GET/POST /api/checkout/*` path — which is **hard-disabled and must stay that
way**. Collection is off in code, not by config. Do not re-enable it.

## Current git state

| | |
| --- | --- |
| Branch | `docs/design-corrections-janitorial` |
| Base | `main` @ `3ae7b36` (Add centered project address banner) |
| Open PR | **#13** — open, MERGEABLE (CLEAN), all checks green |
| Other open PR | **#12** — draft, credential-redaction fix, needs a human merge call |
| Local clone | `/Users/angusdurrie/Development/helicopter-humans` |

**#13 contains, in two commits:**

- `34352d3` — `docs/Z402_THESIS_CORRECTIONS.md` (new), the `Z402_DESIGN.md` item-2
  supersession, the site now serving the correction next to the design proposal,
  plus two janitorial fixes
- `dcf2276` — `docs/Z402_MVP_PRD.md` (new), the sprint scope

Verified on Node 26.10.0 with a fresh `npm ci`: `npm run check` clean, 58/58 e2e
(Desktop + mobile, Playwright). The new doc ships byte-identical with its
SHA-256 in `dist/memory-cleaner-sha256.json`.

## The correction that PR #13 makes

The project had been described as: *take any payment, give it a zero-knowledge
wrapper, fire it over ZEC, and it arrives and unwraps with no paper trail left
behind.*

That framing does not hold. **There is no unwrap step.** A ZK proof proves one
statement and publishes a proof plus a commitment; it wraps nothing. When a
recipient receives a shielded payment they spend a note, and that spend is itself
a new public transaction. The moment of arrival is a new public event, not the
disappearance of one.

Consequences recorded in the corrections doc:

- "Any payment" needs a trusted bridge hop; a bridge is a mint/burn, so either a
  custodian or a fraud window. The bridge is the observer.
- Pay-before-deliver either tells the merchant a payment arrived (a private paper
  trail) or needs a trusted gate.
- The defensible claim is **"a shielded transaction is visible; its participants
  are not"** — not anonymity, and not against a named observer set.
- Ironwood replaced Orchard on mainnet at block 3,428,143 (28 July 2026), so
  Orchard is now withdraw-only. Keep the distinction explicit: the `orchard` crate
  is the crypto library, Ironwood is the pool.

The architecture review (a separate artifact, at revision
`f40aa1d5bc7a61fc05622d04dd50629b255d69f3`) reached the same narrowing
independently, with an observer-by-observer table and citations.

## The sprint scope

Derived from a 20-question scope interview. Full detail in
`docs/Z402_MVP_PRD.md`. Summary:

**The product.** An agent reads a web page and enables private payments for
itself. It pays a live API over Ironwood-shaded ZEC through a gateway we
operate, so the merchant learns it was paid without learning who paid. The demo
proves it by running the same purchase twice — plain x402, then z402 — and
showing raw logs side by side.

**Operator involvement: fund a wallet once.**

**Spend guards (Q8):** daily quota, client-side circuit breaker, timing and
amount jitter. No rate-based price ramping — it gives the merchant a read on
buyer frequency, and a price function of local request count is globally
computable, so it publishes the rhythm it was meant to hide.

**Out of scope:** refunds/expiry cancellation, reorg recovery beyond the runbook,
independent crypto review, correlation resistance beyond jitter, opening to third
parties (we test with our own coins), z402-native merchant adoption, the
shielded-credit ledger, and the rollup.

**Definition of done:** a third party enables it unaided and completes a real
shielded purchase without talking to us.

## What already works (do not rebuild)

- `packages/z402/` — the protocol: signed offers, durable budgets, selected-output
  disclosures, encrypted delivery, portable receipts, merchant. 483 lines JS.
- `tools/z402-wallet/` — the native Rust signer/verifier. Ironwood disclosures
  via Zally, `PostNu6_3`, bounded signing, process-level locking. 754 lines Rust.
- `npm run z402:regtest` — bootstraps an isolated Docker regtest chain + wallet.
- `Z402_REGTEST=1 npm run test:z402:live` — the live acceptance test: serves a
  cooperative merchant on loopback, pays from shielded notes, mines, decrypts,
  restarts, independently verifies the receipt without a payer seed, rejects a
  tampered disclosure.
- `npm run check` — typecheck, lint, Vitest, package node:test, production build.
- `examples/z402/verify-receipt.mjs` — portable receipt verification.

**If you change `tools/z402-wallet/`, rerun the live test and the cargo checks.**
The runbook's dependency pins are load-bearing: the July 2026 Orchard advisory
floor (`halo2_gadgets >= 0.5.0`, `orchard >= 0.14.0`), `ironwood_v3()`,
`PostNu6_3`, and the **explicit refusal of `InsecurePreNu6_2`**.

## The three things that are not done

### 1. Q21 is unanswered — merchant side of the ZEC scheme

The sprint needs someone running a ZEC scheme on the merchant side. Findings
that constrain it:

- x402 v2 is extensible by design. The core spec's `accepts` array is a **list of
  alternatives**, and scheme logic "depends on the payment scheme and network
  (e.g., evm, solana, etc.)". Zcash is a network. A ZEC scheme is legal in the
  format.
- x402 already ships `exact` scheme specs for **18 networks** (evm, solana, svm,
  starknet, stellar, ton, xrpl, cardano, hedera, aptos, near, sui, casper, canton,
  concordium, keeta, lnbtc, hedera) — a `scheme_exact_zcash.md` slot exists.
- `@x402/core` is 2.28.0 with one dependency (`zod`). The type/logic layer is
  clean; everything network-specific is a separate package.
- The spec defines asset transfer method *families*, one being **facilitator-
  submitted** — the signed object MAY be an authorization the facilitator wraps in
  its own transaction. That is the z402 gateway, and it is already a sanctioned
  pattern.
- **`z402-shielded-v1` already implements this end to end** — offer, disclosure,
  receipt, budget. It is just not packaged as an x402 scheme. The work is largely
  reframing existing code as a spec-compliant scheme package.

**Assessment:** client-side is genuinely modular ("slip it onto your stack").
Facilitator-side is a **hosted service**, not a package — it needs a Zcash node, a
nullifier ledger, and a merchant identity. Our gateway is that service. So:
modular add-on for the client, hosted service for the facilitator, package for the
scheme logic.

**Operator context:** the operator runs a **full Zebra node**. It is a drop-in for
the config's `zebra` field (the RPC surface is small and standard —
`getrawtransaction`, `getblock`, `sendrawtransaction`). It solves consensus and
chain state but not note-scanning, shielding, and Ironwood spends — those need
Zally/Zinder. The runbook warns a remote indexer can observe wallet
synchronization, so keep Zinder inside the operator's trusted boundary.

### 2. The mainnet guard is an omission, not a policy

`docs/Z402_RUNBOOK.md` currently reads *"Mainnet is rejected."* That is enforced
by absence — `tools/z402-wallet/src/main.rs:28-30` only matches
`"zcash:testnet"` and `"zcash:regtest"`, so mainnet is refused by a non-match. Q7
wants mainnet as the headline path. That needs a **deliberate policy** with a
spend ceiling, replacing (not merely relaxing) the omission. First code task.

### 3. PR #12 is a draft needing a human decision

`[codex] Prevent custom phrases from bypassing credential redaction` — a custom
phrase like `proj` turned an `sk-proj-…` token into `sk-[CUSTOM]-…`, leaving the
secret body visible in the preview/clipboard/export path. Validated: 528 unit
tests, 10 Chromium e2e, 8 synthetic bypasses reproduce on main and are killed by
the patch, 11,731 phrase-boundary checks. Needs a merge call, not more work.

## Conventions in this repo (follow these)

- **Fail closed.** Checkout and `/api/pay/*` return HTTP 503
  (`checkout_disabled` / `payments_disabled`) until blockers are cleared *in code*.
  Never add a config flag that opens them.
- **No secrets in the repo.** No seed, spend key, or viewing key. Wallet material
  lives in gitignored `.z402-local/` or an operator-private directory.
- **Native errors are deliberately generic** so payment material does not leak
  into logs. Preserve that.
- **Tests use a fake native bridge** for Node-side control flow. That is labelled
  and does not demonstrate settlement. Do not let a fixture satisfy a live gate.
- **CI path filters matter.** `z402.yml` fires on `packages/z402/**`,
  `tools/z402-wallet/**`, `examples/z402/**`, `scripts/z402-*.mjs`, and
  (as of #13) `docs/Z402_*.md`. Changes outside those paths do not run the checks.
- **Conventional commits**, squash-merge feature branches, delete the branch.
- **No LICENSE at repo root.** `orchard` is `MIT OR Apache-2.0` and the Rust
  transitive license inventory is outstanding. Flagged in #13 as not-done.

## How to verify anything

```sh
npm ci
npm run check                      # typecheck, lint, tests, build
npm run test:e2e                   # needs: npx playwright install chromium
cargo fmt --manifest-path tools/z402-wallet/Cargo.toml --check
cargo clippy --locked --manifest-path tools/z402-wallet/Cargo.toml -- -D warnings
cargo test --locked --manifest-path tools/z402-wallet/Cargo.toml
npm run z402:regtest               # bootstrap isolated regtest chain
Z402_REGTEST=1 npm run test:z402:live -- .z402-local/agent-native.json
```

**Node version matters.** The repo requires Node >=24. The default `node` on this
host is v22.23.1 (too old). Use the Homebrew one:
`export PATH="/opt/homebrew/bin:$PATH"` → v26.10.0. This is the exact trap the
PR #12 description documents as a pitfall.

## Local environment notes

- Repo cloned at `/Users/angusdurrie/Development/helicopter-humans` by Hermes, on
  branch `docs/design-corrections-janitorial`, tracking origin.
- `gh` is authenticated. `codex` CLI is at `/opt/homebrew/bin/codex` (0.159.2).
- Playwright Chromium is installed.
- Proving parameters: macOS requires `paramsDir` to end in `ZcashParams`;
  the automated bootstrap targets macOS.

## A note on the privacy claim in anything you write

The site's copy is already disciplined and an e2e test enforces the absence of
anonymity claims on the relay status surface. Keep it that way. Say what the
construction achieves against a named observer set. Do not write "no paper
trail", "anonymous", "untraceable", or "ZK wrapper". The corrections doc has a
do-not-say table with the replacement for each.