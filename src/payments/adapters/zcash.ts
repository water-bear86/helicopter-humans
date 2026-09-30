// Site wrapper around @helicopter-humans/payment-adapter (packages/payment-adapter).
// The package owns x402/CipherPay verification. This file owns three things the site needs:
//   1. the live-readiness guard, enforced before any enabled adapter exists;
//   2. zatoshi <-> ZEC conversion at the site boundary (types.ts amounts are whole-asset decimals);
//   3. server-owned challenge lookup, so settle never trusts a client-supplied quote.
import {
  ADAPTER_ID,
  createPaymentAdapter,
  INTEGRATION_BLOCKERS,
  type AuthorizeOutcome,
  type FacilitatorOutcome,
  type PaymentAdapterInstance,
  type PaymentChallenge,
  type ReceiptLedger,
} from '@helicopter-humans/payment-adapter'
import { PaymentsUnavailableError, type PaymentAdapter, type PaymentResult, type Quote } from '../types.js'

export const ZCASH_ADAPTER_ID = ADAPTER_ID

// Blockers owned by the site rather than the package. Challenges are stored per process, which is
// only correct for a single local process; a live route needs a shared store.
const SITE_BLOCKERS = ['no_durable_challenge_store'] as const

export interface LiveReadiness {
  ready: boolean
  blockers: string[]
}

// The only switch for live collection. Configuration is not an input: env vars cannot clear a blocker.
export function liveReadiness(): LiveReadiness {
  const blockers = [...INTEGRATION_BLOCKERS.map((b) => b.id), ...SITE_BLOCKERS]
  return { ready: blockers.length === 0, blockers }
}

// ---- Amounts ---------------------------------------------------------------------------------

const ZEC_DECIMALS = 8
const ZATOSHIS_PER_ZEC = 10n ** BigInt(ZEC_DECIMALS)
const ZATOSHI_STRING = /^(0|[1-9][0-9]*)$/
const ZEC_STRING = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/

// "100000" zatoshis -> "0.001" ZEC. Exact; throws on anything that is not an unsigned integer string.
export function zatoshisToZec(zatoshis: string): string {
  if (!ZATOSHI_STRING.test(zatoshis)) throw new RangeError(`not an integer zatoshi amount: ${zatoshis}`)
  const value = BigInt(zatoshis)
  const whole = value / ZATOSHIS_PER_ZEC
  const fraction = (value % ZATOSHIS_PER_ZEC).toString().padStart(ZEC_DECIMALS, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : `${whole}`
}

// "0.001" ZEC -> "100000" zatoshis. Exact; throws on more than 8 decimals, signs, exponents or floats.
export function zecToZatoshis(zec: string): string {
  const match = ZEC_STRING.exec(zec)
  if (!match) throw new RangeError(`not a ZEC amount with at most ${ZEC_DECIMALS} decimals: ${zec}`)
  const [, whole, fraction = ''] = match
  return (BigInt(whole) * ZATOSHIS_PER_ZEC + BigInt(fraction.padEnd(ZEC_DECIMALS, '0'))).toString()
}

// ---- Challenge store -------------------------------------------------------------------------

export interface ChallengeStore {
  put(challenge: PaymentChallenge): Promise<void>
  get(quoteId: string): Promise<PaymentChallenge | undefined>
}

// Per-process. Fine for a local fixture run, wrong for anything served by more than one instance.
export class LocalChallengeStore implements ChallengeStore {
  private readonly challenges = new Map<string, PaymentChallenge>()
  async put(challenge: PaymentChallenge) {
    this.challenges.set(challenge.quoteId, challenge)
  }
  async get(quoteId: string) {
    return this.challenges.get(quoteId)
  }
}

// ---- Adapter ---------------------------------------------------------------------------------

type Env = Record<string, string | undefined>

type Facilitator = {
  verify(args: { challenge: PaymentChallenge; txid: string; signal?: AbortSignal }): Promise<FacilitatorOutcome>
}

export interface LocalFixtureOptions {
  // Must point CIPHERPAY_FACILITATOR_URL at a loopback host, which the package reports as `test` mode.
  env: Env
  ledger: ReceiptLedger
  facilitator: Facilitator
  quoteSigningSecret: string
  now?: () => number
}

const DISABLED_NOTE = 'Payments are switched off on this deployment, so no payment data is collected.'

// Registry entry. It takes no env on purpose: env selects this adapter but can never enable it.
// While any blocker stands it returns a refusing adapter without constructing the package adapter
// at all, so there is no payable address, no challenge and no provider call.
export function createZcashAdapter(): PaymentAdapter {
  const { ready, blockers } = liveReadiness()
  if (!ready) return disabledZcashAdapter(blockers)
  // Unreachable until every blocker in liveReadiness() is removed in code. Wiring the durable
  // ledger and challenge store belongs to the change that removes the last of them.
  throw new Error('live Zcash collection has no durable ledger or challenge store wired')
}

// Offline only. Exercises the real package against injected fixtures; refuses a non-loopback provider.
export function createLocalZcashAdapter(options: LocalFixtureOptions): PaymentAdapter {
  const inner = createPaymentAdapter({
    env: options.env,
    ledger: options.ledger,
    facilitator: options.facilitator,
    quoteSigningSecret: options.quoteSigningSecret,
    allowEphemeralLedger: true,
    now: options.now,
  })
  if (inner.mode !== 'test') {
    throw new Error(`local fixture adapter must use a loopback facilitator, got mode "${inner.mode}"`)
  }
  return wrap(inner, new LocalChallengeStore())
}

function disabledZcashAdapter(blockers: readonly string[]): PaymentAdapter {
  return {
    id: ZCASH_ADAPTER_ID,
    mode: 'disabled',
    privacyNote: DISABLED_NOTE,
    blockers,
    async quote() {
      throw new PaymentsUnavailableError()
    },
    async settle(quote) {
      return { status: 'failed', quoteId: quote?.quoteId ?? 'unknown', reason: 'payments_disabled', retryable: false }
    },
  }
}

function resourceFor(productId: string) {
  return {
    url: `urn:helicopter-humans:product:${productId}`,
    description: `Helicopter Humans: ${productId}`,
    mimeType: 'application/json',
  }
}

function toSiteQuote(challenge: PaymentChallenge): Quote {
  const { requirements } = challenge
  return {
    quoteId: challenge.quoteId,
    productId: challenge.productId ?? '',
    amount: zatoshisToZec(requirements.amount),
    // The package adds nothing on top of the signed amount. The payer's wallet adds a Zcash
    // network fee we do not quote, and CipherPay bills the merchant separately.
    adapterFee: '0',
    networkFeeIncluded: false,
    asset: requirements.asset,
    network: requirements.network,
    payTo: requirements.payTo,
    expiresAt: challenge.expiresAt,
  }
}

// A bare txid becomes the PAYMENT-SIGNATURE envelope for the stored challenge; anything else is
// passed through as an envelope and parsed (and bounded) by the package.
function paymentHeader(proof: string, challenge: PaymentChallenge): string {
  const trimmed = proof.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed
  const envelope = { x402Version: 2, accepted: { ...challenge.requirements, extra: {} }, payload: { txid: trimmed.toLowerCase() } }
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
}

function toResult(outcome: AuthorizeOutcome, quoteId: string): PaymentResult {
  switch (outcome.kind) {
    case 'verified':
      return { status: 'succeeded', quoteId, reference: outcome.txid ?? '' }
    case 'pending':
      return { status: 'pending', quoteId, reference: outcome.txid ?? '' }
    case 'upstream_error':
      if (outcome.reason === 'cancelled') return { status: 'cancelled', quoteId }
      return { status: 'failed', quoteId, reason: outcome.buyerMessage, retryable: outcome.retrySameProofSafe }
    default:
      return { status: 'failed', quoteId, reason: outcome.buyerMessage, retryable: false }
  }
}

function wrap(inner: PaymentAdapterInstance, challenges: ChallengeStore): PaymentAdapter {
  return {
    id: inner.id,
    mode: inner.mode,
    privacyNote: inner.privacyNote,
    blockers: liveReadiness().blockers,
    async quote({ productId }) {
      const challenge = inner.createChallenge({ productId, resource: resourceFor(productId) })
      await challenges.put(challenge)
      return toSiteQuote(challenge)
    },
    async settle(quote, proof, signal) {
      const quoteId = quote?.quoteId ?? 'unknown'
      // The stored challenge is authoritative. The client's quote only names it.
      const challenge = await challenges.get(quoteId)
      if (!challenge) return { status: 'failed', quoteId, reason: 'unknown_quote', retryable: false }
      let claimed: string
      try {
        claimed = zecToZatoshis(quote.amount)
      } catch {
        claimed = ''
      }
      if (claimed !== challenge.requirements.amount) {
        return { status: 'failed', quoteId, reason: 'quote_amount_mismatch', retryable: false }
      }
      const outcome = await inner.authorize({
        challenge,
        paymentSignatureHeader: typeof proof === 'string' ? paymentHeader(proof, challenge) : undefined,
        signal,
      })
      return toResult(outcome, quoteId)
    },
  }
}
