import { PaymentsUnavailableError, type PaymentAdapter } from './types'

// Default adapter: refuses everything. Keeps the site honest until a verified adapter is registered.
export const disabledAdapter: PaymentAdapter = {
  id: 'disabled',
  mode: 'disabled',
  privacyNote: 'No payments are processed, so no payment data exists.',
  async quote() {
    throw new PaymentsUnavailableError()
  },
  async settle(quote) {
    return { status: 'failed', quoteId: quote.quoteId, reason: 'payments_disabled', retryable: false }
  },
}
