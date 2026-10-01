// Exact ZEC <-> zatoshi conversion shared by the x402 wrapper and the invoice checkout.
// BigInt only: no floats for money.

const ZEC_DECIMALS = 8
const ZATOSHIS_PER_ZEC = 10n ** BigInt(ZEC_DECIMALS)
const ZATOSHI_STRING = /^(0|[1-9][0-9]*)$/
const ZEC_STRING = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))?$/

// "100000" zatoshis -> "0.001" ZEC. Exact; throws on anything that is not an unsigned integer string.
export function zatoshisToZec(zatoshis: string): string {
  if (!ZATOSHI_STRING.test(zatoshis)) throw new RangeError(`not an integer zatoshi amount: ${zatoshis}`)
  const value = BigInt(zatoshis)
  const whole = value / ZATOSHIS_PER_ZEC
  const fraction = (value % ZATOSHIS_PER_ZEC).toString().padStart(ZEC_DECIMALS, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : `${whole}`
}

// "0.001" ZEC -> "100000" zatoshis. Exact; throws on more than 8 decimals, signs, exponents or floats.
export function zecToZatoshis(zec: string): string {
  const match = ZEC_STRING.exec(zec)
  if (!match) throw new RangeError(`not a ZEC amount with at most ${ZEC_DECIMALS} decimals: ${zec}`)
  const [, whole, fraction = ''] = match
  return (BigInt(whole) * ZATOSHIS_PER_ZEC + BigInt(fraction.padEnd(ZEC_DECIMALS, '0'))).toString()
}
