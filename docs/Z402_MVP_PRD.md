# z402 MVP — sprint PRD

> Living document. Derived from a 20-question scope interview, 2026-09-29.
> Supersedes nothing: read [Z402_THESIS_CORRECTIONS.md](Z402_THESIS_CORRECTIONS.md)
> for the privacy claim, [Z402_DESIGN.md](Z402_DESIGN.md) for the proposal, and
> [Z402_RUNBOOK.md](Z402_RUNBOOK.md) for the existing local slice.

## One-line summary

An agent reads a web page and enables private payments for itself. It pays a live
API over Ironwood-shaded ZEC, through a gateway we operate, so the merchant learns
it was paid without learning who paid. The demo proves it by running the same
purchase twice — plain x402, then z402 — and showing the logs side by side.

## Who it is for

An operator whose agent buys things, and who does not want their funding wallet
linked to those purchases by the merchant or by a public chain observer.

The operator's total involvement: **fund a wallet once**.

## The claim, stated honestly

The merchant cannot link the payment to the buyer. The public chain sees a
shielded transaction and not its participants. **The gateway knows who paid** —
it is our own service, and it is trusted, not anonymous. This is the trade the
sprint makes, and the demo shows it rather than hiding it.

This is not universal anonymity. See the corrections note for what we cannot
claim.

## Requirements, in priority order

| # | Requirement | From |
| --- | --- | --- |
| R1 | An agent reads a page and enables z402 payments with no human setup beyond funding a wallet | Q5, Q13 |
| R2 | The agent uses the whole Zcash node it already runs — no second node | Q6 |
| R3 | Real mainnet spend in shielded Ironwood notes; real proofs, real verification | Q2, Q7 |
| R4 | We operate the gateway and present the merchant an ordinary x402 authorization | Q9, Q12 |
| R5 | The merchant verifies payment without learning the buyer; the buyer keeps private receipts | Q3 |
| R6 | The same purchase runs twice — plain x402, then z402 — and raw logs are shown side by side | Q15, Q16 |
| R7 | Spend guards: daily quota, client-side circuit breaker, timing and amount jitter | Q8 |
| R8 | Three observer surfaces rendered from the run: chain, merchant, gateway | Q4, Q10 |
| R9 | Scripted regtest run ships as the fallback path if mainnet is unsafe this sprint | Q17 |
| R10 | Third party completes a real shielded purchase unaided — this is the definition of done | Q18 |

## Out of scope for this sprint

The spine only: gateway, page, guards, A/B run. Explicitly **not** in this
sprint (Q20):

- Automated refund and expiry cancellation
- Reorg recovery beyond what the runbook already describes
- Independent cryptographic review
- Correlation resistance and timing analysis beyond basic jitter
- Opening to third parties (Q19: we test with our own coins first)
- z402-native merchant adoption, shielded-credit ledger, rollup

## Acceptance criteria

The sprint is done when all of these hold:

1. A clean machine: fund wallet → agent reads page → agent configures itself → real
   mainnet purchase completes. No human command, no manual, no clarification.
2. The A/B run exists as a single command producing two artifact sets.
3. Both artifact sets are raw and verbatim — request headers, chain records,
   gateway logs. No interpretation in the evidence path.
4. The merchant's view contains no buyer identifier, and a reviewer can confirm
   that from the dumps alone.
5. The gateway's view *does* identify the buyer, and the demo shows that too.
6. The daily quota is enforced in code and a test proves exceeding it fails closed.
7. The runbook's "Mainnet is rejected" line is replaced by an explicit mainnet
   policy with the spend ceiling.
8. Regtest fallback runs green from a fresh clone.

## Architecture

```
agent (owns node, wallet, budget)
  │
  │  shielded: Ironwood note, merchant origin + key pinned, offer signed
  ▼
gateway (ours, trusted — sees buyer, amount, timing)
  │  ordinary x402 authorization
  ▼
merchant (sees a paid request; no buyer identifier)
```

The gateway is where buyer privacy is spent. That is the design, not a failure of
it — it is the only route that needs no merchant adoption.

## Known risks, accepted

**R-1. No page integrity (Q14).** By decision: no hashes, no pinned-commit
verification, no operator confirmation. A compromise of the hosting domain or of
anything the page names yields code execution in an agent holding spendable
coins, with no confirmation step to catch it. The daily quota bounds loss per day;
it does not prevent it. *Mitigation, free:* keep the page's authorised surface
minimal — bounded reads of the wallet's own directory, one spend at a time.

**R-2. Jitter versus the observer panes (Q4, Q8).** Timing jitter exists to break
correlation, but panes updating side by side are themselves a correlation. The
panes must read "what this observer is handed", not "what this observer could
correlate". Do not present them as hostile-observer evidence.

**R-3. Real value against an active adversary (Q7).** Mainnet changes the code
from correctness-relevant to adversarially relevant. The architecture review's
conditional go was scoped to local/testnet. The runbook's dependency pins —
`PostNu6_3`, refusal of `InsecurePreNu6_2`, the Orchard advisory floor — are
load-bearing on mainnet, not hygiene.

**R-4. Orchard is withdraw-only.** Ironwood replaced it on mainnet at block
3,428,143 (28 July 2026). The `orchard` crate is the crypto library; Ironwood is
the pool. Keep the distinction explicit in code and docs.

**R-5. Evidence is a diff, not a proof.** Showing that logs differ between two
runs demonstrates a difference. It does not demonstrate unlinkability against an
adversary. Copy must say so.

## Deliberate non-choices

**No rate-based price ramping.** Considered and rejected. Price variation gives
the merchant a read on buyer request frequency, which is the linkage we are
removing; and a price function of local request count is globally computable, so
it publishes the rhythm it was meant to hide. Jitter achieves the anti-fingerprint
goal without a price-derived signal and without taxing the burst patterns agents
actually use.

**No "any payment" / drop-in x402.** Getting existing payments into a shielded
pool needs a trusted bridge hop. The bridge is the observer. See the corrections
note.

**No new circuit.** Use the pinned, reviewed Orchard/Ironwood construction.

## Open questions for the next session

1. Which live paid API is the demo's merchant? Needs to accept plain x402 so the
   baseline run and the z402 run hit the same resource for the same price.
2. What is the daily ceiling in ZEC, and is it per-wallet or per-gateway?
3. Does the gateway hold funds between buyer and merchant, or does settlement
   finalise before the merchant serves?
4. Where does the "Mainnet is rejected" guard live in code today, and does it get
   replaced or made configurable? (Q7 requires a deliberate policy, not an
   omission.)