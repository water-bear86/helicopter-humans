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
  // Decimal string in `asset` units. No floats for money.
  amount: string
  // Adapter/network fee the payer will see, same units as amount. "0" if none.
  fee: string
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
  quote(request: QuoteRequest): Promise<Quote>
  // Confirm a payment for a quote. `proof` is adapter-specific (e.g. a signed payload or tx id).
  // Adapters never receive seed phrases or private keys.
  settle(quote: Quote, proof: string, signal?: AbortSignal): Promise<PaymentResult>
}

export class PaymentsUnavailableError extends Error {
  constructor(message = 'Payments are not enabled on this deployment.') {
    super(message)
    this.name = 'PaymentsUnavailableError'
  }
}
