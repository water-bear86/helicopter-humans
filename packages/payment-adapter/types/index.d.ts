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
  readonly quoteId: string
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
  facilitatorOptions?: Record<string, unknown>
}): PaymentAdapterInstance
