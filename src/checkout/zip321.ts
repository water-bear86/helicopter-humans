// ZIP 321 payment URI check for a provider invoice. CipherPay's pinned source (invoices/mod.rs) emits
// either `zcash:<addr>?amount=..&memo=..` or, when a fee applies, a two-recipient form with
// `address.1`/`amount.1`/`memo.1` paying the provider. The draft offer has no buyer surcharge, so
// anything beyond one recipient, one amount and one memo is refused. We never strip a recipient and
// forward the rest: a rejected URI is never shown.
import { zatoshisToZec, zecToZatoshis } from '../payments/zec.js'

export type UriRejection =
  | 'not_zcash_uri'
  | 'malformed'
  | 'duplicate_parameter'
  | 'unexpected_parameter'
  | 'extra_recipient'
  | 'unapproved_fee_recipient'
  | 'address_mismatch'
  | 'amount_mismatch'
  | 'memo_mismatch'

export interface ExpectedPayment {
  address: string
  amountZatoshis: number
  memoCode: string
}

export type UriCheck = { ok: true; uri: string } | { ok: false; reason: UriRejection }

const MAX_URI = 2048
const PARAM = /^([a-z][a-z0-9-]*)(?:\.([1-9][0-9]{0,3}))?$/

function memoParam(memoCode: string): string {
  return Buffer.from(memoCode, 'utf8').toString('base64url')
}

// Canonical single-recipient URI. What the buyer's wallet receives is rebuilt from validated values,
// not echoed from the provider.
export function paymentUri(expected: ExpectedPayment): string {
  return `zcash:${expected.address}?amount=${zatoshisToZec(String(expected.amountZatoshis))}&memo=${memoParam(expected.memoCode)}`
}

export function checkPaymentUri(uri: unknown, expected: ExpectedPayment): UriCheck {
  if (typeof uri !== 'string' || uri.length > MAX_URI || !uri.startsWith('zcash:')) return { ok: false, reason: 'not_zcash_uri' }
  const rest = uri.slice('zcash:'.length)
  const q = rest.indexOf('?')
  const path = q < 0 ? rest : rest.slice(0, q)
  const query = q < 0 ? '' : rest.slice(q + 1)
  if (query.includes('#')) return { ok: false, reason: 'malformed' }

  const params = new Map<string, string>()
  const indexed = new Set<string>()
  let feeLike = false
  for (const part of query ? query.split('&') : []) {
    const eq = part.indexOf('=')
    if (eq <= 0) return { ok: false, reason: 'malformed' }
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    const match = PARAM.exec(key)
    if (!match) return { ok: false, reason: 'malformed' }
    const [, name, index] = match
    if (index !== undefined) {
      // Any `.N` parameter is a second payment in the same transaction.
      indexed.add(index)
      if (name === 'amount' || name === 'address') feeLike = true
      continue
    }
    if (params.has(name)) return { ok: false, reason: 'duplicate_parameter' }
    params.set(name, value)
  }
  if (indexed.size > 0) return { ok: false, reason: feeLike ? 'unapproved_fee_recipient' : 'extra_recipient' }

  if (path && params.has('address')) return { ok: false, reason: 'duplicate_parameter' }
  for (const name of params.keys()) {
    if (name === 'amount' || name === 'memo') continue
    if (name === 'address' && path === '') continue
    return { ok: false, reason: 'unexpected_parameter' }
  }
  const address = path || params.get('address') || ''
  if (address !== expected.address) return { ok: false, reason: 'address_mismatch' }

  const amount = params.get('amount')
  let zatoshis: string
  try {
    zatoshis = zecToZatoshis(amount ?? '')
  } catch {
    return { ok: false, reason: 'amount_mismatch' }
  }
  if (zatoshis !== String(expected.amountZatoshis)) return { ok: false, reason: 'amount_mismatch' }
  if (params.get('memo') !== memoParam(expected.memoCode)) return { ok: false, reason: 'memo_mismatch' }

  return { ok: true, uri: paymentUri(expected) }
}
