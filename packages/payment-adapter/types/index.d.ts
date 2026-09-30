// Hand-written declarations so the site's TypeScript stack can consume this
// package without a build step. Keep in sync with the JSDoc in src/.

export type AdapterMode = 'disabled' | 'test' | 'live'

export interface AdapterConfig {
  readonly apiKey: string
  readonly payTo: string
  readonly network: string
  readonly facilitatorUrl: string
  readonly priceZatoshis: bigint
  readonly hostedFacilitator: boolean
}

export interface ResolvedConfig {
  readonly mode: AdapterMode
  readonly problems: readonly string[]
  readonly config: AdapterConfig | undefined
}

export interface PaymentRequirements {
  readonly scheme: 'exact'
  readonly network: string
  readonly asset: 'ZEC'
  /** Integer zatoshis as a decimal string. */
  readonly amount: string
  readonly payTo: string
  readonly maxTimeoutSeconds: number
  readonly extra: Readonly<Record<string, never>>
}

export interface PaymentResource {
  readonly url: string
  readonly description: string
  readonly mimeType: string
}

export interface PaymentChallenge {
  /**
   * `<nonce>.<mac>`. Opaque: the mac seals every server-owned field of this
   * challenge, which is how `settle` tells a quote we issued from one a caller
   * assembled or edited. Do not parse it, and do not build one by hand.
   */
  readonly quoteId: string
  /** Set when the challenge came from `quote()`; null for a direct resource. */
  readonly productId: string | null
  readonly x402Version: 2
  readonly resource: PaymentResource
  readonly requirements: PaymentRequirements
  readonly createdAt: string
  readonly expiresAt: string
}

export interface PaymentEnvelope {
  readonly x402Version: 2
  readonly accepted: Readonly<Record<string, unknown>>
  /** Lower-cased 64-hex Zcash transaction id. */
  readonly txid: string
}

export type EnvelopeParseResult =
  | { ok: true; envelope: PaymentEnvelope }
  | { ok: false; reason: string; detail: string }

export type OutcomeKind =
  | 'disabled'
  | 'payment_required'
  | 'pending'
  | 'rejected'
  | 'verified'
  | 'upstream_error'

export type FacilitatorOutcome =
  | { kind: 'verified' }
  | { kind: 'pending'; reason: string; detail: string; operatorActionRequired: boolean }
  | { kind: 'rejected'; reason: string; detail: string; operatorActionRequired: boolean }
  | { kind: 'upstream_error'; reason: string; detail: string; operatorActionRequired: boolean }

export interface AuthorizeOutcome {
  readonly kind: OutcomeKind
  readonly reason?: string
  /** Operator-facing detail. Never show this to a buyer. */
  readonly detail?: string
  readonly mismatches?: readonly string[]
  readonly quoteId: string
  readonly txid?: string
  readonly replay: boolean
  readonly verifiedAt?: string
  readonly retryAfterSeconds?: number
  readonly operatorActionRequired: boolean
  readonly retrySameProofSafe: boolean
  readonly operatorFacing: boolean
  /** Safe to render to a buyer verbatim. */
  readonly buyerMessage: string
  readonly httpStatus: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Readonly<Record<string, unknown>>
}

export type RecordState = 'claimed' | 'granted' | 'rejected'
export type ClaimStatus = 'acquired' | 'owned' | 'taken'

export interface ReceiptRecord {
  readonly network: string
  readonly merchantId: string
  readonly txid: string
  readonly requestId: string
  /** Integer zatoshis as a decimal string. */
  readonly amountZatoshis: string
  /**
   * The resource this payment bought. One txid grants one resource: a durable
   * ledger MUST store this and MUST return `taken` when a claim arrives for the
   * same txid with a different resource. The adapter re-checks the value it
   * gets back and fails closed if it is missing.
   */
  readonly resource: string
  readonly state: RecordState
  readonly outcome?: { reason: string | null; detail: string }
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ClaimRequest {
  readonly network: string
  readonly merchantId: string
  readonly txid: string
  readonly requestId: string
  readonly amountZatoshis: string
  /** The resource URL this payment buys. Compared, not merely stored. */
  readonly resource: string
}

export interface ClaimResult {
  readonly status: ClaimStatus
  readonly record: ReceiptRecord
}

export interface SettleRequest extends ClaimRequest {
  readonly state: RecordState
  readonly outcome: { reason: string | null; detail: string }
}

export interface ReceiptLedger {
  /** Must be true for any deployment that collects money. */
  readonly durable: boolean
  /** MUST be atomic: one conditional insert, not a read then a write. */
  claim(claim: ClaimRequest): Promise<ClaimResult>
  settle(settlement: SettleRequest): Promise<ReceiptRecord>
  get(key: { network: string; merchantId: string; txid: string }): Promise<ReceiptRecord | undefined>
}

export interface Quote {
  quoteId: string
  productId: string
  amount: string
  fee: string
  asset: string
  network: string
  payTo: string
  expiresAt: string
}

export type PaymentResult =
  | { status: 'succeeded'; quoteId: string; reference: string }
  | { status: 'pending'; quoteId: string; reference: string }
  | { status: 'failed'; quoteId: string; reason: string; retryable: boolean }
  | { status: 'cancelled'; quoteId: string }

export interface IntegrationBlocker {
  readonly id: string
  readonly summary: string
  readonly resolvedBy: string
}

export interface PaymentAdapterInstance {
  readonly id: string
  readonly mode: AdapterMode
  readonly scheme: 'exact'
  readonly asset: 'ZEC'
  readonly supportedNetwork: string
  readonly privacyNote: string
  readonly integrationBlockers: readonly IntegrationBlocker[]
  readonly readyForLivePaidRoute: boolean
  readonly configProblems: readonly string[]
  readonly warnings: readonly string[]
  readonly network?: string
  readonly payTo?: string
  readonly priceZatoshis?: string
  readonly priceZec?: string
  readonly merchantId?: string
  readonly verifyUrl?: string
  createChallenge(args: {
    resource: { url: string; description?: string; mimeType?: string }
    productId?: string | null
    /** The nonce to use. A mac is appended to it; the result is the quote id. */
    quoteId?: string
    ttlSeconds?: number
  }): PaymentChallenge
  quote(request: { productId: string }): Promise<Quote>
  authorize(args: {
    challenge: PaymentChallenge
    paymentSignatureHeader: string | undefined
    requestId?: string
    signal?: AbortSignal
  }): Promise<AuthorizeOutcome>
  settle(quote: Quote, proof: string, signal?: AbortSignal): Promise<PaymentResult>
}

export declare const ADAPTER_ID: string
export declare const PRIVACY_NOTE: string
export declare const INTEGRATION_BLOCKERS: readonly IntegrationBlocker[]
export declare function createPaymentAdapter(options?: {
  env?: Record<string, string | undefined>
  config?: AdapterConfig
  ledger?: ReceiptLedger
  facilitator?: { verify(args: { challenge: PaymentChallenge; txid: string; signal?: AbortSignal }): Promise<FacilitatorOutcome>; verifyUrl?: string }
  fetch?: typeof fetch
  now?: () => number
  logger?: { warn?: (fields: Record<string, unknown>) => void; error?: (fields: Record<string, unknown>) => void }
  merchantId?: string
  allowEphemeralLedger?: boolean
  quoteTtlSeconds?: number
  maxTimeoutSeconds?: number
  limits?: { maxHeaderBytes?: number; maxEnvelopeBytes?: number }
  resourceForProduct?: (productId: string) => { url: string; description?: string; mimeType?: string }
  /**
   * Secret for the mac in every quote id. Derived from the API key when
   * omitted, which means rotating the key invalidates quotes still in flight
   * (they fail closed, within the quote TTL). Set this explicitly to survive a
   * rotation, and share it across every instance serving the route.
   */
  quoteSigningSecret?: string | Buffer
  facilitatorOptions?: Record<string, unknown>
}): PaymentAdapterInstance

export declare function deriveQuoteSigningSecret(apiKey: string): Buffer
export declare function challengeClaims(challenge: unknown): string
export declare function createQuoteSigner(options: { secret: string | Buffer }): {
  issue(nonce: string, claims: string): string
  verify(quoteId: unknown, claims: string): boolean
}
