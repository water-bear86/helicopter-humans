import { describe, expect, it, vi } from 'vitest'
import { shieldedAddressKind } from './address'
import { CIPHERPAY_ORIGIN, checkProviderOrigin, createCipherPayClient, parseCreated } from './cipherpay'
import { createFixtureCipherPay, FIXTURE_API_KEY, FIXTURE_ORIGIN, unpayableAddress } from './fixture-cipherpay'
import { validSaplingAddress, validUnifiedAddress } from './test-support'

const ID = '3f2b8c1e-6a4d-4e2f-9b1a-2c3d4e5f6a7b'

function client(fetchImpl: typeof fetch, extra: Partial<Parameters<typeof createCipherPayClient>[0]> = {}) {
  return createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: fetchImpl, allowLoopback: true, timeoutMs: 100, ...extra })
}

function reply(body: unknown, status = 200) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
}

function invoiceBody(overrides: Record<string, unknown> = {}) {
  const address = unpayableAddress()
  return {
    id: ID,
    memo_code: 'CP-0A1B2C3D',
    status: 'pending',
    amount: 9,
    currency: 'USD',
    price_zec: 0.006397224,
    price_zatoshis: 639722,
    received_zatoshis: 0,
    payment_address: address,
    zcash_uri: `zcash:${address}?amount=0.00639722&memo=Q1AtMEExQjJDM0Q`,
    expires_at: '2026-10-01T00:30:00Z',
    detected_txid: null,
    detected_at: null,
    confirmed_at: null,
    ...overrides,
  }
}

describe('CipherPay client', () => {
  it('only talks to the pinned origin (or loopback when explicitly allowed)', () => {
    expect(checkProviderOrigin('https://api.cipherpay.app')).toBe(CIPHERPAY_ORIGIN)
    for (const bad of ['http://api.cipherpay.app', 'https://api.cipherpay.app.evil.test', 'https://evil.test', 'https://api.cipherpay.app/v2', FIXTURE_ORIGIN]) {
      expect(() => checkProviderOrigin(bad)).toThrow()
    }
    expect(checkProviderOrigin(FIXTURE_ORIGIN, true)).toBe(FIXTURE_ORIGIN)
    expect(() => checkProviderOrigin('http://10.0.0.1', true)).toThrow()
  })

  it('sends server-owned terms with Bearer auth and no refund address or buyer data', async () => {
    const provider = createFixtureCipherPay()
    const spy = vi.fn(provider.fetch)
    const res = await client(spy as typeof fetch).createInvoice({ productName: 'Founding Agent Pass preorder', amount: 9, currency: 'USD' })
    expect(res.kind).toBe('created')
    const [url, init] = spy.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${FIXTURE_ORIGIN}/api/invoices`)
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${FIXTURE_API_KEY}`)
    expect(JSON.parse(String(init.body))).toEqual({ product_name: 'Founding Agent Pass preorder', amount: 9, currency: 'USD' })
    expect(init.redirect).toBe('error')
  })

  it('the create response has a float price and no integer amount, as upstream', async () => {
    const provider = createFixtureCipherPay()
    const res = await client(provider.fetch).createInvoice({ productName: 'x', amount: 9, currency: 'USD' })
    if (res.kind !== 'created') throw new Error(res.kind)
    expect(res.invoice).not.toHaveProperty('priceZatoshis')
    expect(Number.isInteger(res.invoice.priceZec * 1e8)).toBe(false)
  })

  it('classifies 4xx as a definite refusal and 5xx, timeouts, bad bodies and oversized bodies as unknown', async () => {
    const req = { productName: 'x', amount: 9, currency: 'USD' as const }
    expect(await client(reply({ error: 'no' }, 401)).createInvoice(req)).toEqual({ kind: 'rejected', httpStatus: 401 })
    expect(await client(reply({ error: 'no' }, 500)).createInvoice(req)).toEqual({ kind: 'unknown', reason: 'http_500' })
    expect(await client(reply({ error: 'timeout' }, 408)).createInvoice(req)).toEqual({ kind: 'unknown', reason: 'http_408' })
    expect(await client(reply({ error: 'gone' }, 499)).createInvoice(req)).toEqual({ kind: 'unknown', reason: 'http_499' })
    expect(await client(reply({ invoice_id: ID }, 201)).createInvoice(req)).toEqual({ kind: 'unknown', reason: 'malformed_response' })
    expect(await client(reply('not json', 201)).createInvoice(req)).toEqual({ kind: 'unknown', reason: 'malformed_response' })
    expect(await client(reply({ x: 'y'.repeat(100) }, 201), { maxResponseBytes: 50 }).createInvoice(req)).toEqual({ kind: 'unknown', reason: 'response_too_large' })
    const hang = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))))
    expect(await client(hang as unknown as typeof fetch).createInvoice(req)).toEqual({ kind: 'unknown', reason: 'network_or_timeout' })
  })

  it('reads integer amounts only when they are exact safe integers', async () => {
    const ok = await client(reply(invoiceBody())).getInvoice(ID)
    expect(ok).toMatchObject({ kind: 'ok', invoice: { priceZatoshis: 639722, receivedZatoshis: 0 } })
    const cases: string[] = [
      JSON.stringify(invoiceBody()).replace('"price_zatoshis":639722', '"price_zatoshis":9007199254740993'),
      JSON.stringify(invoiceBody()).replace('"price_zatoshis":639722', '"price_zatoshis":639722.0'),
      JSON.stringify(invoiceBody()).replace('"price_zatoshis":639722', '"price_zatoshis":6.39722e5'),
      JSON.stringify(invoiceBody({ price_zatoshis: '639722' })),
      JSON.stringify(invoiceBody({ price_zatoshis: 0 })),
      JSON.stringify(invoiceBody({ received_zatoshis: -1 })),
      JSON.stringify(invoiceBody({ received_zatoshis: 1.5 })),
      JSON.stringify(invoiceBody({ price_zec: 'NaN' })),
      JSON.stringify(invoiceBody({ detected_txid: 'not-a-txid' })),
      JSON.stringify(invoiceBody({ detected_at: 'yesterday' })),
      JSON.stringify(invoiceBody({ confirmed_at: 1759278600 })),
      JSON.stringify(invoiceBody({ id: 'CP-0A1B2C3D' })),
    ]
    for (const body of cases) expect(await client(reply(body)).getInvoice(ID)).toEqual({ kind: 'unavailable', reason: 'malformed_response' })
    expect(await client(reply({ error: 'Invoice not found' }, 404)).getInvoice(ID)).toEqual({ kind: 'not_found' })
  })

  it('reads the provider detection and confirmation stamps, which upstream omits until they happen', async () => {
    const stamps = { status: 'confirmed', detected_at: '2026-10-01T00:29:00Z', confirmed_at: '2026-10-01T00:45:00Z', expires_at: '2026-10-01T00:59:00Z' }
    expect(await client(reply(invoiceBody(stamps))).getInvoice(ID)).toMatchObject({
      kind: 'ok',
      invoice: { detectedAt: '2026-10-01T00:29:00Z', confirmedAt: '2026-10-01T00:45:00Z', expiresAt: '2026-10-01T00:59:00Z' },
    })
    const { detected_at: _d, confirmed_at: _c, ...absent } = invoiceBody()
    expect(await client(reply(absent)).getInvoice(ID)).toMatchObject({ kind: 'ok', invoice: { detectedAt: null, confirmedAt: null } })
  })

  it('never builds a request path from anything but a provider UUID', async () => {
    const spy = reply(invoiceBody())
    await expect(client(spy).getInvoice('../merchants/me')).rejects.toThrow(RangeError)
    await expect(client(spy).getInvoice('CP-0A1B2C3D')).rejects.toThrow(RangeError)
    expect(spy).not.toHaveBeenCalled()
  })

  it('parseCreated rejects a response carrying a malformed address or memo', () => {
    const good = { invoice_id: ID, memo_code: 'CP-0A1B2C3D', amount: 9, currency: 'USD', price_zec: 0.0064, payment_address: unpayableAddress(), zcash_uri: 'zcash:x', expires_at: '2026-10-01T00:30:00Z' }
    expect(parseCreated(good)).toBeDefined()
    expect(parseCreated({ ...good, payment_address: 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU' })).toBeUndefined()
    expect(parseCreated({ ...good, memo_code: 'CP-zz' })).toBeUndefined()
    expect(parseCreated({ ...good, expires_at: 'tomorrow' })).toBeUndefined()
  })
})

describe('shielded address checks', () => {
  it('accepts checksummed mainnet unified and Sapling addresses only', () => {
    expect(shieldedAddressKind(validUnifiedAddress())).toBe('unified')
    expect(shieldedAddressKind(validSaplingAddress())).toBe('sapling')
    expect(shieldedAddressKind(validUnifiedAddress().toUpperCase())).toBeUndefined()
    expect(shieldedAddressKind('t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU')).toBeUndefined()
    expect(shieldedAddressKind('')).toBeUndefined()
  })

  it('fixture invoice addresses fail the checksum, so no wallet can pay them', () => {
    for (let i = 0; i < 20; i++) expect(shieldedAddressKind(unpayableAddress())).toBeUndefined()
  })
})
