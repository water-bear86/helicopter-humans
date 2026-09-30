// Request handling for api/checkout/*. The recovery code travels only in `Authorization: Bearer`,
// never in a URL, cookie or body, so browsers never attach it on their own and there is no ambient
// credential for a cross-site request to ride on. State-changing requests must also be same-origin
// JSON. Responses are never cached and send no referrer. Nothing here logs request data.
import { bearerCode, hashRecoveryCode } from './credential.js'
import type { CreateScenario } from './fixture-cipherpay.js'
import type { CheckoutRuntime } from './runtime.js'
import { CheckoutError, type OrderView } from './service.js'
import { StoreConflictError, StoreUnavailableError } from './store.js'

const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}
const MAX_BODY = 2048

export function respond(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: HEADERS })
}

// Same shape as /api/pay/*: no offer, no address, no URI, no provider call.
export function checkoutDisabled(): Response {
  return respond({ error: 'checkout_disabled' }, 503)
}

function fail(code: string, status: number): Response {
  return respond({ error: code }, status)
}

function sameOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin') return false
  const origin = request.headers.get('origin')
  return origin !== null && origin === new URL(request.url).origin
}

async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return undefined
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) return undefined
  const text = await request.text()
  if (text.length > MAX_BODY) return undefined
  try {
    const body: unknown = JSON.parse(text)
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function onlyKeys(body: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(body).every((k) => allowed.includes(k))
}

async function guarded(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CheckoutError) return fail(error.code, error.httpStatus)
    if (error instanceof StoreUnavailableError) return fail('order_store_unavailable', 503)
    if (error instanceof StoreConflictError) return fail('conflict_retry', 409)
    return fail('internal_error', 500)
  }
}

// GET /api/checkout/orders: what the preview page needs to render. POST: create an order.
export async function handleOrders(request: Request, runtime: CheckoutRuntime): Promise<Response> {
  if (runtime.mode === 'disabled') return checkoutDisabled()
  if (request.method === 'GET') {
    const { offer } = runtime
    return respond({
      mode: runtime.mode,
      blockers: runtime.blockers,
      offer: {
        id: offer.id,
        version: offer.version,
        approved: offer.approved,
        title: offer.title,
        priceLabel: offer.priceLabel,
        summary: offer.summary,
        refundTerms: offer.refundTerms,
      },
    })
  }
  if (request.method !== 'POST') return fail('method_not_allowed', 405)
  if (!sameOrigin(request)) return fail('cross_origin_refused', 403)
  const body = await readJson(request)
  if (!body || !onlyKeys(body, [])) return fail('invalid_request', 400)
  return guarded(async () => respond(await runtime.service.createOrder(), 201))
}

const FIXTURE_EVENTS = ['pay_full', 'pay_partial', 'confirm', 'expire', 'provider_refund', 'next_fee_recipient', 'next_timeout'] as const

type FixtureRuntime = Extract<CheckoutRuntime, { mode: 'fixture' }>
// Simulated outcome for an order's next quote, keyed by credential hash (fixture only).
const nextScenario = new WeakMap<FixtureRuntime, Map<string, CreateScenario>>()

function scenarioFor(runtime: CheckoutRuntime, code: string, take = false): CreateScenario | undefined {
  if (runtime.mode !== 'fixture') return undefined
  const map = nextScenario.get(runtime)
  const key = hashRecoveryCode(code)
  const scenario = map?.get(key)
  if (take) map?.delete(key)
  return scenario
}

async function fixtureEvent(runtime: FixtureRuntime, code: string, event: unknown): Promise<OrderView> {
  if (!FIXTURE_EVENTS.includes(event as (typeof FIXTURE_EVENTS)[number])) throw new CheckoutError('action_not_allowed', 400)
  const { provider, service } = runtime
  if (event === 'next_fee_recipient' || event === 'next_timeout') {
    await service.getOrder(code)
    if (!nextScenario.has(runtime)) nextScenario.set(runtime, new Map())
    nextScenario.get(runtime)!.set(hashRecoveryCode(code), event === 'next_timeout' ? 'timeout' : 'fee_recipient')
  } else {
    // Acts on this order's own active invoice, found through the credential like everything else.
    const snapshot = await runtime.store.findByCredentialHash(hashRecoveryCode(code))
    const id = snapshot?.order.activeInvoiceId
    const inv = id ? provider.invoices.get(id) : undefined
    if (!inv) throw new CheckoutError('action_not_allowed', 409)
    if (event === 'pay_full') provider.pay(inv.id, inv.price_zatoshis)
    if (event === 'pay_partial') provider.pay(inv.id, Math.floor(inv.price_zatoshis / 2))
    if (event === 'confirm') provider.confirm(inv.id)
    if (event === 'expire') provider.expire(inv.id)
    if (event === 'provider_refund') provider.refund(inv.id)
  }
  return service.getOrder(code)
}

// GET /api/checkout/order: the caller's order. POST: an action on it.
export async function handleOrder(request: Request, runtime: CheckoutRuntime): Promise<Response> {
  if (runtime.mode === 'disabled') return checkoutDisabled()
  const code = bearerCode(request)
  if (!code) return fail('recovery_code_required', 401)
  const { service } = runtime
  if (request.method === 'GET') return guarded(async () => respond(await service.getOrder(code)))
  if (request.method !== 'POST') return fail('method_not_allowed', 405)
  if (!sameOrigin(request)) return fail('cross_origin_refused', 403)
  const body = await readJson(request)
  if (!body) return fail('invalid_request', 400)
  const action = body.action
  // Every action names only itself. Invoice ids, memo codes, txids, prices or order ids are refused
  // outright rather than ignored, so a client cannot come to rely on them.
  const allowed: Record<string, string[]> = {
    create_invoice: ['action'],
    new_quote: ['action'],
    refresh: ['action'],
    cancel: ['action'],
    request_refund: ['action', 'refundAddress'],
    fixture_event: ['action', 'event'],
  }
  if (typeof action !== 'string' || !Object.hasOwn(allowed, action) || !onlyKeys(body, allowed[action])) return fail('invalid_request', 400)
  return guarded(async () => {
    switch (action) {
      case 'create_invoice':
      case 'new_quote': {
        const create = () => service.ensureInvoice(code, { newQuote: action === 'new_quote' })
        const scenario = scenarioFor(runtime, code, true)
        return respond(await (scenario && runtime.mode === 'fixture' ? runtime.provider.withScenario(scenario, create) : create()))
      }
      case 'refresh':
        return respond(await service.refresh(code))
      case 'cancel':
        return respond(await service.cancel(code))
      case 'request_refund':
        return respond(await service.requestRefund(code, body.refundAddress))
      default:
        if (runtime.mode !== 'fixture') return fail('invalid_request', 400)
        return respond(await fixtureEvent(runtime, code, body.event))
    }
  })
}
