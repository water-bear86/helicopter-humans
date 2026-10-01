/**
 * Money handling. Zcash amounts are integer zatoshis (1 ZEC = 1e8 zatoshis).
 * Everything crossing a boundary is a decimal string; everything compared is
 * a BigInt. There is no float path: CipherPay's v1 endpoint takes a
 * `expected_amount_zec` float, the v2 endpoint we use takes an integer string,
 * and we only ever speak v2.
 */

export const ZATOSHIS_PER_ZEC = 100000000n

/** CipherPay parses `paymentRequirements.amount` into a Rust u64. */
export const MAX_ZATOSHIS = 18446744073709551615n

/**
 * Underpayment tolerance applied by the provider, as an exact rational.
 * `SLIPPAGE_TOLERANCE = 0.995` in cipherpay-api `src/api/x402.rs`. The
 * provider accepts a payment that is up to 0.5% short of the quoted amount.
 */
export const PROVIDER_SLIPPAGE_NUMERATOR = 995n
export const PROVIDER_SLIPPAGE_DENOMINATOR = 1000n

const INTEGER_STRING = /^(0|[1-9][0-9]*)$/

/**
 * Parse an integer-zatoshi amount. Accepts a decimal string or a BigInt.
 * Rejects floats, negatives, signs, whitespace, exponents and anything a
 * `Number` round-trip would silently mangle.
 *
 * @param {unknown} value
 * @returns {{ ok: true, value: bigint } | { ok: false, reason: string }}
 */
export function parseZatoshis(value) {
  let text
  if (typeof value === 'bigint') {
    text = value.toString()
  } else if (typeof value === 'string') {
    text = value
  } else {
    return { ok: false, reason: 'amount must be a decimal string or BigInt' }
  }

  if (!INTEGER_STRING.test(text)) {
    return { ok: false, reason: 'amount must be an unsigned integer string of zatoshis' }
  }

  const parsed = BigInt(text)
  if (parsed <= 0n) {
    return { ok: false, reason: 'amount must be greater than zero' }
  }
  if (parsed > MAX_ZATOSHIS) {
    return { ok: false, reason: 'amount exceeds the u64 range the facilitator accepts' }
  }
  return { ok: true, value: parsed }
}

/**
 * The lowest amount the provider will still accept for a given quote, given
 * its 0.5% tolerance. Exposed for documentation and tests only: the v2 verify
 * response does NOT report a received amount, so we cannot recompute or
 * enforce this ourselves. See `docs` in README.md.
 *
 * @param {bigint} quotedZatoshis
 * @returns {bigint}
 */
export function providerMinAcceptableZatoshis(quotedZatoshis) {
  return (quotedZatoshis * PROVIDER_SLIPPAGE_NUMERATOR) / PROVIDER_SLIPPAGE_DENOMINATOR
}

/**
 * Human-readable ZEC rendering for display only. Never used for comparison.
 *
 * @param {bigint} zatoshis
 * @returns {string}
 */
export function formatZec(zatoshis) {
  const whole = zatoshis / ZATOSHIS_PER_ZEC
  const fraction = (zatoshis % ZATOSHIS_PER_ZEC).toString().padStart(8, '0').replace(/0+$/, '')
  return fraction.length === 0 ? `${whole}` : `${whole}.${fraction}`
}
