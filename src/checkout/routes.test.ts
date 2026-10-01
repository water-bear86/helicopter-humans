import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as getOrder, POST as postOrder } from '../../api/checkout/order'
import { GET as getOrders, POST as postOrders } from '../../api/checkout/orders'
import { GET as status } from '../../api/status'
import { handleOrder, handleOrders } from './http'
import { CHECKOUT_BLOCKERS, checkoutMode } from './readiness'
import { createFixtureRuntime, liveCheckoutFromEnv, resolveCheckout } from './runtime'
import { StoreUnavailableError } from './store'
import { validUnifiedAddress } from './test-support'

const ORIGIN = 'https://helicopter-humans.vercel.app'

// Everything a live deployment would need, as fake values. None of it may enable anything.
const FULL_ENV = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  NODE_ENV: 'production',
  CHECKOUT_MODE: 'live',
  CIPHERPAY_API_KEY: 'cpay_sk_fixture_not_a_real_key',
  CHECKOUT_DATABASE_URL: 'postgres://checkout:secret@db.example.com/checkout?sslmode=require',
  PAYMENT_ADAPTER: 'cipherpay-zcash-shielded',
  ZCASH_PAYTO_UA: 'u1fixturefixturefixturefixturefixturefixturefixturefixturefixture00',
}

function req(path: string, init: RequestInit & { code?: string; body?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.code) headers.set('authorization', `Bearer ${init.code}`)
  if (init.method === 'POST') {
    if (!headers.has('origin')) headers.set('origin', ORIGIN)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  }
  return new Request(`${ORIGIN}${path}`, { ...init, headers })
}

const post = (path: string, body: unknown, extra: RequestInit & { code?: string } = {}) =>
  req(path, { ...extra, method: 'POST', body: JSON.stringify(body) })

describe('checkout routes on a deployment with a complete environment', () => {
  const fetchSpy = vi.fn()
  beforeEach(() => {
    for (const [k, v] of Object.entries(FULL_ENV)) vi.stubEnv(k, v)
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fetchSpy.mockReset()
  })

  it('every checkout route answers 503 with no offer, address, URI, challenge or provider call', async () => {
    const code = `hhr_${'A'.repeat(43)}`
    const responses = [
      await getOrders(req('/api/checkout/orders')),
      await postOrders(post('/api/checkout/orders', {})),
      await getOrder(req('/api/checkout/order', { code })),
      await postOrder(post('/api/checkout/order', { action: 'create_invoice' }, { code })),
      await postOrder(post('/api/checkout/order', { action: 'fixture_event', event: 'pay_full' }, { code })),
    ]
    for (const res of responses) {
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ error: 'checkout_disabled' })
      expect(res.headers.get('payment-required')).toBeNull()
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fixture mode is refused on a host even when asked for', () => {
    vi.stubEnv('CHECKOUT_MODE', 'fixture')
    expect(resolveCheckout(process.env).mode).toBe('disabled')
    expect(checkoutMode({ CHECKOUT_MODE: 'fixture', VERCEL: '1' })).toBe('disabled')
    expect(checkoutMode({ CHECKOUT_MODE: 'fixture', VERCEL_ENV: 'preview' })).toBe('disabled')
    expect(checkoutMode({ CHECKOUT_MODE: 'fixture', NODE_ENV: 'production' })).toBe('disabled')
    expect(checkoutMode({ CHECKOUT_MODE: 'fixture' })).toBe('fixture')
  })

  it('status names every checkout blocker and reports it disabled without echoing configuration', async () => {
    const body = await status().json()
    expect(body.checkout).toEqual({ mode: 'disabled', collecting: false, blockers: [...CHECKOUT_BLOCKERS] })
    expect(body.checkout.blockers).toEqual([
      'offer_not_approved',
      'merchant_fee_config_unverified',
      'durable_store_not_deployed',
      'no_confirmed_payer',
      'no_authorized_mainnet_e2e',
    ])
    const text = JSON.stringify(body)
    expect(text).not.toContain(FULL_ENV.CIPHERPAY_API_KEY)
    expect(text).not.toContain('db.example.com')
  })

  it('the live composition cannot be built while blockers remain, and never without a durable store', () => {
    expect(() => liveCheckoutFromEnv(process.env)).toThrow(/not ready/)
    expect(() => liveCheckoutFromEnv({ ...FULL_ENV, CHECKOUT_DATABASE_URL: '' }, [])).toThrow(/no non-durable fallback/)
    expect(() => liveCheckoutFromEnv({ ...FULL_ENV, CIPHERPAY_API_KEY: '' }, [])).toThrow(/CIPHERPAY_API_KEY/)
    expect(() => liveCheckoutFromEnv({ ...FULL_ENV, CHECKOUT_DATABASE_URL: 'postgres://u:p@db.example.com/x' }, [])).toThrow(/sslmode/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('checkout routes in local fixture mode', () => {
  it('creates an order, returns the recovery code once, and serves the order only to its bearer', async () => {
    const rt = createFixtureRuntime()
    const created = await handleOrders(post('/api/checkout/orders', {}), rt)
    expect(created.status).toBe(201)
    expect(created.headers.get('referrer-policy')).toBe('no-referrer')
    const { recoveryCode, order } = await created.json()
    expect(recoveryCode).toMatch(/^hhr_[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify(order)).not.toContain(recoveryCode)

    const invoice = await (await handleOrder(post('/api/checkout/order', { action: 'create_invoice' }, { code: recoveryCode }), rt)).json()
    expect(invoice.state).toBe('awaiting_payment')
    expect(JSON.stringify(invoice)).not.toContain(recoveryCode)
    const view = await handleOrder(req('/api/checkout/order', { code: recoveryCode }), rt)
    expect((await view.json()).payment.address).toBe(invoice.payment.address)
  })

  it('an invoice id, memo code or txid alone grants nothing, and cannot be smuggled into an action', async () => {
    const rt = createFixtureRuntime()
    const a = await (await handleOrders(post('/api/checkout/orders', {}), rt)).json()
    const view = await (await handleOrder(post('/api/checkout/order', { action: 'create_invoice' }, { code: a.recoveryCode }), rt)).json()
    const inv = [...rt.provider.invoices.values()][0]
    const txid = rt.provider.pay(inv.id, inv.price_zatoshis)
    rt.provider.confirm(inv.id)
    const b = await (await handleOrders(post('/api/checkout/orders', {}), rt)).json()

    // No credential at all.
    for (const body of [{ action: 'refresh', invoiceId: inv.id }, { action: 'refresh' }]) {
      expect((await handleOrder(post('/api/checkout/order', body), rt)).status).toBe(401)
    }
    // Public identifiers as the credential.
    for (const fake of [inv.id, inv.memo_code, txid, view.payment.reference]) {
      expect((await handleOrder(req('/api/checkout/order', { headers: { authorization: `Bearer ${fake}` } }), rt)).status).toBe(401)
    }
    // Buyer B naming A's invoice, memo or txid.
    for (const extra of [{ invoiceId: inv.id }, { memo: inv.memo_code }, { txid }, { orderId: 'x' }, { amount: '0.01' }]) {
      const res = await handleOrder(post('/api/checkout/order', { action: 'refresh', ...extra }, { code: b.recoveryCode }), rt)
      expect(res.status).toBe(400)
    }
    const bView = await (await handleOrder(post('/api/checkout/order', { action: 'refresh' }, { code: b.recoveryCode }), rt)).json()
    expect(bView.receipt).toBeNull()
    const refund = await handleOrder(post('/api/checkout/order', { action: 'request_refund', refundAddress: validUnifiedAddress() }, { code: b.recoveryCode }), rt)
    expect(refund.status).toBe(409)
    expect(await refund.json()).toEqual({ error: 'nothing_to_refund' })

    const aView = await (await handleOrder(post('/api/checkout/order', { action: 'refresh' }, { code: a.recoveryCode }), rt)).json()
    expect(aView.state).toBe('fulfilled')
  })

  it('refuses cross-site and non-JSON state changes', async () => {
    const rt = createFixtureRuntime()
    expect((await handleOrders(post('/api/checkout/orders', {}, { headers: { origin: 'https://evil.test' } }), rt)).status).toBe(403)
    expect((await handleOrders(post('/api/checkout/orders', {}, { headers: { origin: ORIGIN, 'sec-fetch-site': 'cross-site' } }), rt)).status).toBe(403)
    const noOrigin = new Request(`${ORIGIN}/api/checkout/orders`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    expect((await handleOrders(noOrigin, rt)).status).toBe(403)
    expect((await handleOrders(post('/api/checkout/orders', {}, { headers: { origin: ORIGIN, 'content-type': 'text/plain' } }), rt)).status).toBe(400)
    expect((await handleOrders(post('/api/checkout/orders', { offerId: 'founding-agent-pass', price: 1 }), rt)).status).toBe(400)
  })

  it('reports a store outage as 503 without calling the provider', async () => {
    const rt = createFixtureRuntime()
    const { recoveryCode } = await (await handleOrders(post('/api/checkout/orders', {}), rt)).json()
    const spy = vi.spyOn(rt.store, 'update').mockRejectedValue(new StoreUnavailableError())
    const res = await handleOrder(post('/api/checkout/order', { action: 'create_invoice' }, { code: recoveryCode }), rt)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'order_store_unavailable' })
    expect(rt.provider.calls.create).toBe(0)
    spy.mockRestore()
  })

  it('the fixture route is reachable through the real handlers when not hosted', async () => {
    vi.stubEnv('CHECKOUT_MODE', 'fixture')
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'test')
    try {
      const res = await getOrders(req('/api/checkout/orders'))
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ mode: 'fixture', offer: { approved: false, version: '2026-09-30-draft-1' } })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
