// Contract between the site and any payment adapter. See docs/PAYMENT_ADAPTER.md.
// Deliberately says nothing about x402, Zcash or swaps: adapters decide how, this file decides what.

export type AdapterMode = 'disabled' | 'test' | 'live'

export interface QuoteRequest {
  // Stable id of the thing being bought, e.g. "founding-pass".
  productId: string
}

export interface Quote {
  quoteId: string
  productId: string
  // Decimal string in whole `asset` units ("0.001" ZEC, never "100000" zatoshis). No floats for money.
  // Adapters that work in base units convert at their own boundary.
  amount: string
  // Charged by the adapter on top of `amount`, same units. "0" if none. Never includes a network fee.
  adapterFee: string
  // Whether the payer's network (miner) fee is inside amount + adapterFee. When false, the payer
  // also pays a network fee we do not quote: never present amount + adapterFee as the total cost.
  networkFeeIncluded: boolean
  asset: string
  network: string
  // Destination the payer is sending to. Must come from configuration, never user input.
  payTo: string
  expiresAt: string
}

export type PaymentResult =
  | { status: 'succeeded'; quoteId: string; reference: string }
  | { status: 'pending'; quoteId: string; reference: string }
  | { status: 'failed'; quoteId: string; reason: string; retryable: boolean }
  | { status: 'cancelled'; quoteId: string }

export interface PaymentAdapter {
  id: string
  mode: AdapterMode
  // Plain-language statement of what privacy this adapter actually provides. Shown to users verbatim.
  privacyNote: string
  // Why this adapter cannot collect money yet. Absent or empty only when it can.
  blockers?: readonly string[]
  quote(request: QuoteRequest): Promise<Quote>
  // Confirm a payment for a quote. `proof` is adapter-specific (e.g. a signed payload or tx id).
  // Only the quote id and amount are taken from the caller: the adapter looks up the terms it issued
  // and must reject an amount that differs. Adapters never receive seed phrases or private keys.
  settle(quote: Pick<Quote, 'quoteId' | 'amount'>, proof: string, signal?: AbortSignal): Promise<PaymentResult>
}

export class PaymentsUnavailableError extends Error {
  constructor(message = 'Payments are not enabled on this deployment.') {
    super(message)
    this.name = 'PaymentsUnavailableError'
  }
}
