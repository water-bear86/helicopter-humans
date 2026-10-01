// GET/POST /api/checkout/orders - 503 `checkout_disabled` unless the local fixture runtime is active.
// See src/checkout/runtime.ts for why no environment can enable collection while blockers remain.
import { handleOrders } from '../../src/checkout/http.js'
import { resolveCheckout } from '../../src/checkout/runtime.js'

export function GET(request: Request): Promise<Response> {
  return handleOrders(request, resolveCheckout(process.env))
}

export function POST(request: Request): Promise<Response> {
  return handleOrders(request, resolveCheckout(process.env))
}
