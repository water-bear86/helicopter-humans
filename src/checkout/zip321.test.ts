import { describe, expect, it } from 'vitest'
import { unpayableAddress } from './fixture-cipherpay'
import { checkPaymentUri } from './zip321'

const address = unpayableAddress()
const other = unpayableAddress()
const memo = Buffer.from('CP-0A1B2C3D').toString('base64url')
const expected = { address, amountZatoshis: 639722, memoCode: 'CP-0A1B2C3D' }

describe('ZIP 321 payment URI check', () => {
  it('accepts the upstream single-recipient form and rebuilds it canonically', () => {
    const res = checkPaymentUri(`zcash:${address}?amount=0.00639722&memo=${memo}`, expected)
    expect(res).toEqual({ ok: true, uri: `zcash:${address}?amount=0.00639722&memo=${memo}` })
    expect(checkPaymentUri(`zcash:?address=${address}&amount=0.00639722&memo=${memo}`, expected).ok).toBe(true)
    expect(checkPaymentUri(`zcash:${address}?amount=0.006397220&memo=${memo}`, expected).ok).toBe(false)
  })

  it('refuses the upstream fee form instead of stripping the fee recipient', () => {
    const fee = `zcash:?address=${address}&amount=0.00639722&memo=${memo}&address.1=${other}&amount.1=0.00006397&memo.1=RkVF`
    expect(checkPaymentUri(fee, expected)).toEqual({ ok: false, reason: 'unapproved_fee_recipient' })
    expect(checkPaymentUri(`zcash:${address}?amount=0.00639722&memo=${memo}&memo.1=RkVF`, expected)).toEqual({ ok: false, reason: 'extra_recipient' })
  })

  it.each([
    [`zcash:${other}?amount=0.00639722&memo=${memo}`, 'address_mismatch'],
    [`zcash:${address}?amount=0.00639723&memo=${memo}`, 'amount_mismatch'],
    [`zcash:${address}?amount=6.39722e-3&memo=${memo}`, 'amount_mismatch'],
    [`zcash:${address}?amount=0.006397220001&memo=${memo}`, 'amount_mismatch'],
    [`zcash:${address}?memo=${memo}`, 'amount_mismatch'],
    [`zcash:${address}?amount=0.00639722&memo=AAAA`, 'memo_mismatch'],
    [`zcash:${address}?amount=0.00639722&amount=0.00639722&memo=${memo}`, 'duplicate_parameter'],
    [`zcash:${address}?address=${address}&amount=0.00639722&memo=${memo}`, 'duplicate_parameter'],
    [`zcash:${address}?amount=0.00639722&memo=${memo}&message=hi`, 'unexpected_parameter'],
    [`zcash:${address}?amount=0.00639722&memo=${memo}&req-fee=1`, 'unexpected_parameter'],
    [`zcash:${address}?amount=0.00639722&memo=${memo}#x`, 'malformed'],
    [`zcash:${address}?amount&memo=${memo}`, 'malformed'],
    [`bitcoin:${address}?amount=0.00639722`, 'not_zcash_uri'],
    [`zcash:${address}?amount=0.00639722&memo=${memo}&x=${'a'.repeat(3000)}`, 'not_zcash_uri'],
  ])('rejects %s (%s)', (uri, reason) => {
    expect(checkPaymentUri(uri, expected)).toEqual({ ok: false, reason })
  })
})
