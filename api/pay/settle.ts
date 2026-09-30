// POST /api/pay/settle - fails closed with 503 unless the active adapter is live. See src/payments/http.ts.
import { handleSettle, unavailable } from '../../src/payments/http.js'
import { getAdapter } from '../../src/payments/registry.js'

export function POST(request: Request): Promise<Response> | Response {
  const adapter = getAdapter(process.env.PAYMENT_ADAPTER)
  return adapter.mode === 'live' ? handleSettle(request, adapter) : unavailable()
}
