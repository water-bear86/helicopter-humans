import { describe, expect, it } from 'vitest'
import { getAdapter } from './registry'
import { PaymentsUnavailableError } from './types'

describe('payment registry', () => {
  it('falls back to the disabled adapter for unknown or missing ids', () => {
    expect(getAdapter(undefined).id).toBe('disabled')
    expect(getAdapter('zcash-magic').id).toBe('disabled')
  })

  it('disabled adapter refuses to quote or settle', async () => {
    const adapter = getAdapter('disabled')
    await expect(adapter.quote({ productId: 'founding-pass' })).rejects.toBeInstanceOf(PaymentsUnavailableError)
    const quote = {
      quoteId: 'q1', productId: 'founding-pass', amount: '5', adapterFee: '0', networkFeeIncluded: false,
      asset: 'USDC', network: 'none', payTo: 'none', expiresAt: new Date(0).toISOString(),
    }
    expect(await adapter.settle(quote, 'proof')).toMatchObject({ status: 'failed', retryable: false })
  })
})
