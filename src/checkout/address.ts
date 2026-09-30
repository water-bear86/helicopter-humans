// Shielded Zcash address checks. Bech32 (BIP 173) for Sapling `zs1`, Bech32m (BIP 350) for Unified
// `u1` (ZIP 316, no 90-character limit). This proves the string is well formed with a valid checksum;
// it does not decode receivers or prove anyone controls the address.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32 = 1
const BECH32M = 0x2bc830a3

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]
  }
  return chk >>> 0
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5)
  out.push(0)
  for (const c of hrp) out.push(c.charCodeAt(0) & 31)
  return out
}

// Returns the checksum constant the string verifies under, or undefined.
function checksumOf(value: string, hrp: string): number | undefined {
  if (value !== value.toLowerCase()) return undefined
  if (!value.startsWith(`${hrp}1`)) return undefined
  const data: number[] = []
  for (const c of value.slice(hrp.length + 1)) {
    const v = CHARSET.indexOf(c)
    if (v < 0) return undefined
    data.push(v)
  }
  if (data.length < 7) return undefined
  const mod = polymod([...hrpExpand(hrp), ...data])
  return mod === BECH32 || mod === BECH32M ? mod : undefined
}

export type ShieldedKind = 'unified' | 'sapling'

// Mainnet only. Transparent `t1`/`t3` addresses and testnet prefixes are rejected.
export function shieldedAddressKind(value: string): ShieldedKind | undefined {
  if (typeof value !== 'string' || value.length > 1024) return undefined
  if (value.startsWith('u1') && value.length >= 100 && checksumOf(value, 'u') === BECH32M) return 'unified'
  if (value.startsWith('zs1') && value.length === 78 && checksumOf(value, 'zs') === BECH32) return 'sapling'
  return undefined
}

// Shape of a provider-issued invoice address. Charset and length only: the provider owns the checksum,
// and fixture addresses deliberately fail it so that no wallet can pay them.
export function looksLikeUnifiedAddress(value: unknown): value is string {
  return typeof value === 'string' && /^u1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{60,1000}$/.test(value)
}

// For tests and the fixture provider: a correctly checksummed Bech32m string over `data` (5-bit values).
export function encodeBech32m(hrp: string, data: number[]): string {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const mod = polymod(values) ^ BECH32M
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map((v) => CHARSET[v]).join('')}`
}

export function encodeBech32(hrp: string, data: number[]): string {
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const mod = polymod(values) ^ BECH32
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map((v) => CHARSET[v]).join('')}`
}

// Refund requests show a masked address back to the buyer, never the full string.
export function maskAddress(value: string): string {
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`
}
