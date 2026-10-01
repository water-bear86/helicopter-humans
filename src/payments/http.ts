// Shared request handling for api/pay/*. Routes only reach these handlers for a `live` adapter;
// every other mode gets `unavailable()`, which carries no address, quote or payment challenge.
import { PaymentsUnavailableError, type PaymentAdapter } from './types.js'

const NO_STORE = { 'cache-control': 'no-store' }

export function unavailable(): Response {
  return Response.json({ error: 'payments_disabled' }, { status: 503, headers: NO_STORE })
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json()
    return body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export async function handleQuote(request: Request, adapter: PaymentAdapter): Promise<Response> {
  const body = await readJson(request)
  const productId = body?.productId
  if (typeof productId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(productId)) {
    return Response.json({ error: 'invalid_product' }, { status: 400, headers: NO_STORE })
  }
  try {
    return Response.json(await adapter.quote({ productId }), { headers: NO_STORE })
  } catch (error) {
    if (error instanceof PaymentsUnavailableError) return unavailable()
    throw error
  }
}

export async function handleSettle(request: Request, adapter: PaymentAdapter): Promise<Response> {
  const body = await readJson(request)
  const quote = body?.quote as { quoteId?: unknown; amount?: unknown } | undefined
  if (typeof quote?.quoteId !== 'string' || typeof quote.amount !== 'string' || typeof body?.proof !== 'string') {
    return Response.json({ error: 'invalid_request' }, { status: 400, headers: NO_STORE })
  }
  // Only the quote id and amount are forwarded; the adapter looks up its own stored terms.
  const result = await adapter.settle({ quoteId: quote.quoteId, amount: quote.amount }, body.proof, request.signal)
  const status = result.status === 'succeeded' ? 200 : result.status === 'pending' ? 202 : 402
  return Response.json(result, { status, headers: NO_STORE })
}
