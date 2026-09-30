import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as quoteRoute } from '../../api/pay/quote'
import { POST as settleRoute } from '../../api/pay/settle'
import { GET as status } from '../../api/status'
import { createLocalZcashAdapter, ZCASH_ADAPTER_ID } from './adapters/zcash'
import { handleQuote, handleSettle } from './http'

// Everything the package needs to look configured. Not real values; must still not enable anything.
const CONFIGURED = {
  PAYMENT_ADAPTER: ZCASH_ADAPTER_ID,
  CIPHERPAY_API_KEY: 'fixture-not-a-real-key',
  ZCASH_PAYTO_UA: 'u1fixturefixturefixturefixturefixturefixturefixturefixturefixture00',
  ZCASH_PRICE_ZATOSHIS: '100000',
}

function post(body: unknown) {
  return new Request('https://example.test/api/pay', { method: 'POST', body: JSON.stringify(body) })
}

describe('payment routes with a fully configured Zcash environment', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    for (const [k, v] of Object.entries(CONFIGURED)) vi.stubEnv(k, v)
    vi.stubGlobal('fetch', fetchSpy)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fetchSpy.mockReset()
  })

  it('status reports the adapter as disabled, not collecting, with its blockers', async () => {
    const body = await status().json()
    expect(body.payments).toMatchObject({ adapter: ZCASH_ADAPTER_ID, mode: 'disabled', collecting: false })
    expect(body.payments.blockers).toContain('no_payer_binding')
    expect(JSON.stringify(body)).not.toContain(CONFIGURED.ZCASH_PAYTO_UA)
    expect(JSON.stringify(body)).not.toContain(CONFIGURED.CIPHERPAY_API_KEY)
  })

  it('quote fails closed with no address and no payment challenge', async () => {
    const res = await quoteRoute(post({ productId: 'founding-pass' }))
    expect(res.status).toBe(503)
    expect(res.headers.get('payment-required')).toBeNull()
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ error: 'payments_disabled' })
    expect(text).not.toContain('u1')
  })

  it('settle fails closed and never calls the provider', async () => {
    const res = await settleRoute(post({ quote: { quoteId: 'q', amount: '0.001' }, proof: 'a'.repeat(64) }))
    expect(res.status).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// The handlers the routes would reach once live, driven by the offline fixture adapter.
describe('payment handlers', () => {
  const adapter = createLocalZcashAdapter({
    env: { ...CONFIGURED, CIPHERPAY_FACILITATOR_URL: 'http://127.0.0.1:59999' },
    ledger: { durable: false, claim: vi.fn(), settle: vi.fn(), get: vi.fn() },
    facilitator: { verify: vi.fn() },
    quoteSigningSecret: 'fixture-quote-signing-secret',
  })

  it('validates input', async () => {
    expect((await handleQuote(post({ productId: '../etc' }), adapter)).status).toBe(400)
    expect((await handleQuote(new Request('https://example.test', { method: 'POST', body: 'nope' }), adapter)).status).toBe(400)
    expect((await handleSettle(post({ quote: { quoteId: 'q' }, proof: 'x' }), adapter)).status).toBe(400)
  })

  it('returns a whole-ZEC quote and forwards only id and amount to settle', async () => {
    const quote = await (await handleQuote(post({ productId: 'founding-pass' }), adapter)).json()
    expect(quote).toMatchObject({ amount: '0.001', adapterFee: '0', networkFeeIncluded: false })
    const res = await handleSettle(post({ quote: { ...quote, amount: '100000' }, proof: 'a'.repeat(64) }), adapter)
    expect(res.status).toBe(402)
    expect(await res.json()).toMatchObject({ reason: 'quote_amount_mismatch' })
  })
})
