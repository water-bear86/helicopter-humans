# Correcting the z402 mental model

> Status: design note, not a protocol change. Written 2026-09-29 to replace a
> specific framing that does not survive contact with how zero-knowledge proofs
> actually work. Read alongside [Z402_DESIGN.md](Z402_DESIGN.md) and
> [Z402_RUNBOOK.md](Z402_RUNBOOK.md).

## The framing being replaced

The project has been described internally as: take any payment, give it a
zero-knowledge wrapper, send it over ZEC, and it arrives and unwraps with no paper
trail left behind, then the service is delivered.

That sentence is wrong in one load-bearing way. Everything else follows from the
error.

## There is no unwrap step

A zero-knowledge proof is not a wrapper. It proves exactly one statement — that
the prover knows a witness `W` such that `W` satisfies relation `R` — and
publishes the proof plus a commitment. Nothing is wrapped, and nothing is
unwrapped on arrival.

When a recipient "receives" a shielded payment, they spend a shielded note, and
**that spend is itself a new public transaction**. The moment of arrival is a new
public event, not the disappearance of one. A shielded Orchard spend hides the
witness (sender, recipient, amount); it does not hide the fact, time, size, fee or
position of the event on chain.

So the achievable goal is not "no paper trail". It is: the public chain learns that
*a shielded transaction occurred*, and not who paid whom or for what.

## "Any payment" does not work

x402 payments are typically USDC on Base. Moving that value into a Zcash shielded
pool requires a bridge, and a bridge is a mint/burn — which means either a
custodian or a light client with a fraud window. Either way there is a trusted hop
that observes the crossing, and a mint/redeem path on the asset side that is
linkable.

There is no way to admit arbitrary existing payments into a shielded pool without a
trusted hop. This is a property of the asset, not an engineering gap to be closed
later.

## "Services are delivered" carries an unavoidable tension

Either the merchant learns that payment arrived — in which case a private paper
trail exists — or they do not, and then there is no way to enforce pay-before-
deliver without a trusted gate. There is no third option, and no circuit produces
one.

## The defensible version

Three claims this project can actually make, in descending order of strength:

1. **Selective disclosure of payment proof.** A merchant receives proof of payment
   they can verify, without learning or publishing which agent it came from. This
   is the genuinely valuable primitive and it is real.
2. **Operator-internal accounting.** The operator retains budgets and receipts.
   Nobody else sees them. Domain-separated nullifiers keep proofs of different
   payments unlinkable to each other.
3. **Fewer observers, not zero.** A public chain observer sees a shielded event
   rather than your wallet. A network observer sees relay-to-merchant rather than
   you-to-relay. Every design choice shrinks someone's view.

Shrinking the set of observers is the product. It is not a retreat from a stronger
goal; it is the strongest goal the cryptography actually supports.

## What the architecture review already concluded

This note reaches the same place the bounded review reached independently, with
citations. From `Z402_ARCHITECTURE_REVIEW.md` (reviewed at revision
`f40aa1d5bc7a61fc05622d04dd50629b255d69f3`):

> **Verdict: conditional go for an existing native shielded-note payment plus
> private transport; no-go for claiming the proposed generic shielded-credit
> ledger, universal x402 compatibility, or a ZK rollup is ready.**

The review's observer-by-observer table and its "this is an engineering threat
model, not observed anonymity" caveat are the correct register for anything we say
publicly.

## Language to stop using

These phrases are not defensible against a cryptography-literate reader, and using
them costs credibility for the parts of the work that are real:

| Do not say | Say instead |
| --- | --- |
| "No paper trail" | "A shielded transaction is visible; its participants are not" |
| "Anonymous payments" | "Payments unlinkable to the funding wallet, against a named observer set" |
| "ZK wrapper" / "unwrapped on arrival" | "A zero-knowledge proof of an authorized spend" |
| "Any payment" / "drop-in x402" | "Native shielded ZEC, with one cooperating merchant" |
| "Zero knowledge" before a reviewed verifier exists | Name the actual proof system and its review status |
| "Rollup" for batched requests | "Batching" or "a batch transport" |

The site's existing copy is already more disciplined than most of this — keep it
that way. The e2e suite enforces an anonymity-claims guard on the relay status
surface; that guard should be extended rather than relaxed.

## Open question this note does not settle

Whether selective disclosure is sufficient for a paying merchant is an empirical
question, not a theoretical one. If merchants will not accept a proof they cannot
tie to a customer, the honest product is a gateway that presents its own
authorization — which reintroduces custody and gateway correlation. That trade is
the real MVP decision, and it belongs to a merchant conversation, not to us.