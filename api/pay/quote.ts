// POST /api/pay/quote - fails closed with 503 unless the active adapter is live. See src/payments/http.ts.
import { handleQuote, unavailable } from '../../src/payments/http.js'
import { getAdapter } from '../../src/payments/registry.js'

export function POST(request: Request): Promise<Response> | Response {
  const adapter = getAdapter(process.env.PAYMENT_ADAPTER)
  return adapter.mode === 'live' ? handleQuote(request, adapter) : unavailable()
}
