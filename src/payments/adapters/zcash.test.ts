import { INTEGRATION_BLOCKERS, type ClaimRequest, type FacilitatorOutcome, type ReceiptLedger, type ReceiptRecord, type SettleRequest } from '@helicopter-humans/payment-adapter'
import { describe, expect, it, vi } from 'vitest'
import { PaymentsUnavailableError } from '../types'
import { createLocalZcashAdapter, createZcashAdapter, liveReadiness, zatoshisToZec, zecToZatoshis } from './zcash'

// Invented offline values. The UA is shaped to pass validation and is not a real address; the
// loopback facilitator URL is what makes this a local fixture rather than a provider network.
const FIXTURE_ENV = {
  CIPHERPAY_API_KEY: 'fixture-not-a-real-key',
  ZCASH_PAYTO_UA: 'u1fixturefixturefixturefixturefixturefixturefixturefixturefixture00',
  ZCASH_PRICE_ZATOSHIS: '100000',
  CIPHERPAY_FACILITATOR_URL: 'http://127.0.0.1:59999',
}
const TXID = 'a'.repeat(64)

// Atomic enough for one process: claim does its check and insert without an await in between.
function memoryLedger(): ReceiptLedger {
  const records = new Map<string, ReceiptRecord>()
  const key = (r: { network: string; merchantId: string; txid: string }) => `${r.network}|${r.merchantId}|${r.txid}`
  return {
    durable: false,
    async claim(claim: ClaimRequest) {
      const existing = records.get(key(claim))
      if (existing) {
        const same = existing.requestId === claim.requestId && existing.resource === claim.resource
        return { status: same ? 'owned' : 'taken', record: existing }
      }
      const now = new Date().toISOString()
      const record: ReceiptRecord = { ...claim, state: 'claimed', createdAt: now, updatedAt: now }
      records.set(key(claim), record)
      return { status: 'acquired', record }
    },
    async settle(settlement: SettleRequest) {
      const existing = records.get(key(settlement))
      if (!existing) throw new Error('settle before claim')
      const record: ReceiptRecord = { ...existing, state: settlement.state, outcome: settlement.outcome, updatedAt: new Date().toISOString() }
      records.set(key(settlement), record)
      return record
    },
    async get(k) {
      return records.get(key(k))
    },
  }
}

function localAdapter(verify = vi.fn(async (): Promise<FacilitatorOutcome> => ({ kind: 'verified' }))) {
  const adapter = createLocalZcashAdapter({
    env: FIXTURE_ENV,
    ledger: memoryLedger(),
    facilitator: { verify },
    quoteSigningSecret: 'fixture-quote-signing-secret',
  })
  return { adapter, verify }
}

describe('zatoshi <-> ZEC conversion', () => {
  it('maps 100000 zatoshis to 0.001 ZEC and back, exactly', () => {
    expect(zatoshisToZec('100000')).toBe('0.001')
    expect(zecToZatoshis('0.001')).toBe('100000')
    expect(zatoshisToZec('100000000')).toBe('1')
    expect(zatoshisToZec('1')).toBe('0.00000001')
    expect(zatoshisToZec('18446744073709551615')).toBe('184467440737.09551615')
  })

  it('round-trips without loss', () => {
    for (const z of ['1', '99', '100000', '123456789', '100000000', '2100000000000000', '18446744073709551615']) {
      expect(zecToZatoshis(zatoshisToZec(z))).toBe(z)
    }
  })

  it('refuses anything that could silently change the amount', () => {
    for (const bad of ['0.000000001', '1e-3', '-1', '+1', ' 1', '1.', '.1', '0x10', '1,5', '']) {
      expect(() => zecToZatoshis(bad)).toThrow(RangeError)
    }
    for (const bad of ['1.5', '-1', '1e5', ' 1', '01', '']) {
      expect(() => zatoshisToZec(bad)).toThrow(RangeError)
    }
  })
})

describe('live-readiness guard', () => {
  it('is not ready while the package or the site has blockers', () => {
    const readiness = liveReadiness()
    expect(readiness.ready).toBe(false)
    expect(readiness.blockers).toEqual(expect.arrayContaining(INTEGRATION_BLOCKERS.map((b) => b.id)))
    expect(readiness.blockers).toContain('no_durable_challenge_store')
  })

  it('returns a refusing adapter with no payable address, whatever the environment', async () => {
    const adapter = createZcashAdapter()
    expect(adapter.mode).toBe('disabled')
    expect(JSON.stringify(adapter)).not.toContain('u1')
    await expect(adapter.quote({ productId: 'founding-pass' })).rejects.toBeInstanceOf(PaymentsUnavailableError)
    expect(await adapter.settle({ quoteId: 'q', amount: '0.001' }, TXID)).toMatchObject({ status: 'failed', retryable: false })
  })
})

describe('local fixture adapter', () => {
  it('refuses a non-loopback facilitator', () => {
    expect(() =>
      createLocalZcashAdapter({
        env: { ...FIXTURE_ENV, CIPHERPAY_FACILITATOR_URL: 'https://api.cipherpay.app' },
        ledger: memoryLedger(),
        facilitator: { verify: async () => ({ kind: 'verified' }) },
        quoteSigningSecret: 'fixture-quote-signing-secret',
      }),
    ).toThrow(/loopback/)
  })

  it('quotes in whole ZEC and states the fee boundary', async () => {
    const { adapter } = localAdapter()
    expect(adapter.mode).toBe('test')
    const quote = await adapter.quote({ productId: 'founding-pass' })
    expect(quote).toMatchObject({ amount: '0.001', adapterFee: '0', networkFeeIncluded: false, asset: 'ZEC' })
  })

  it('settles against the stored challenge and passes the signed zatoshi amount to the provider', async () => {
    const { adapter, verify } = localAdapter()
    const quote = await adapter.quote({ productId: 'founding-pass' })
    expect(await adapter.settle(quote, TXID)).toEqual({ status: 'succeeded', quoteId: quote.quoteId, reference: TXID })
    expect(verify).toHaveBeenCalledOnce()
    const [{ challenge }] = verify.mock.calls[0] as unknown as [{ challenge: { requirements: { amount: string } } }]
    expect(challenge.requirements.amount).toBe('100000')
  })

  it('rejects a client quote whose amount differs from the one issued, before any provider call', async () => {
    const { adapter, verify } = localAdapter()
    const quote = await adapter.quote({ productId: 'founding-pass' })
    for (const amount of ['100000', '0.0001', '0.00100001', 'nope']) {
      expect(await adapter.settle({ ...quote, amount }, TXID)).toMatchObject({ status: 'failed', reason: 'quote_amount_mismatch' })
    }
    expect(verify).not.toHaveBeenCalled()
  })

  it('never rebuilds a quote from client input', async () => {
    const { adapter, verify } = localAdapter()
    const quote = await adapter.quote({ productId: 'founding-pass' })
    expect(await adapter.settle({ quoteId: `${quote.quoteId}x`, amount: quote.amount }, TXID)).toMatchObject({ reason: 'unknown_quote' })
    expect(verify).not.toHaveBeenCalled()
  })

  it('does not grant one txid twice', async () => {
    const { adapter } = localAdapter()
    const first = await adapter.quote({ productId: 'founding-pass' })
    const second = await adapter.quote({ productId: 'founding-pass' })
    expect((await adapter.settle(first, TXID)).status).toBe('succeeded')
    expect(await adapter.settle(second, TXID)).toMatchObject({ status: 'failed', retryable: false })
  })

  it('maps pending, provider rejection and cancellation', async () => {
    const pending = localAdapter(vi.fn(async () => ({ kind: 'pending' as const, reason: 'transaction_not_visible', detail: '', operatorActionRequired: false })))
    const q1 = await pending.adapter.quote({ productId: 'founding-pass' })
    expect(await pending.adapter.settle(q1, TXID)).toMatchObject({ status: 'pending', reference: TXID })

    const rejected = localAdapter(vi.fn(async () => ({ kind: 'rejected' as const, reason: 'insufficient_funds', detail: '', operatorActionRequired: false })))
    const q2 = await rejected.adapter.quote({ productId: 'founding-pass' })
    expect(await rejected.adapter.settle(q2, TXID)).toMatchObject({ status: 'failed', retryable: false })

    const cancelled = localAdapter(vi.fn(async () => ({ kind: 'upstream_error' as const, reason: 'cancelled', detail: '', operatorActionRequired: false })))
    const q3 = await cancelled.adapter.quote({ productId: 'founding-pass' })
    expect(await cancelled.adapter.settle(q3, TXID)).toEqual({ status: 'cancelled', quoteId: q3.quoteId })
  })
})
