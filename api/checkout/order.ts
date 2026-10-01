// GET/POST /api/checkout/order - the caller's own order, identified only by `Authorization: Bearer`.
// 503 `checkout_disabled` unless the local fixture runtime is active. See src/checkout/http.ts.
import { handleOrder } from '../../src/checkout/http.js'
import { resolveCheckout } from '../../src/checkout/runtime.js'

export function GET(request: Request): Promise<Response> {
  return handleOrder(request, resolveCheckout(process.env))
}

export function POST(request: Request): Promise<Response> {
  return handleOrder(request, resolveCheckout(process.env))
}
