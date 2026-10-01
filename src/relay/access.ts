// Who may use the relay, and how a call is counted. The handler asks the gate to reserve one call
// before any upstream contact and settles the reservation exactly once afterwards.
//
// Two gates exist today:
// - `unavailableGate`: refuses everything. What any hosted runtime gets while RELAY_BLOCKERS stand.
// - `LocalPrototypeGate`: one operator-generated local token, an in-memory rate limit, no credit.
//   Local prototype use only; its counters vanish with the process.
//
// A paid gate replaces the local one later (docs/RELAY.md, "Connecting usage credit"). It must keep
// this contract: reserve atomically against durable credit before contact, settle once, and accept
// only a relay service credential. A checkout recovery code, provider invoice id, memo code, public
// txid or receipt id is never a relay credential: each is refused here by shape before any lookup.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { RouteId } from './routes.js'

export type AccessRefusal = 'credential_required' | 'credential_rejected' | 'insufficient_credit' | 'rate_limited' | 'access_unavailable'

export interface Reservation {
  id: string
  route: RouteId
  units: number
}

export type AccessDecision = { ok: true; reservation: Reservation } | { ok: false; reason: AccessRefusal }

// consumed: the upstream was contacted (success or upstream failure). released: refused before contact.
export type Settlement = 'consumed' | 'released'

export interface RelayAccessGate {
  readonly kind: 'unavailable' | 'local-prototype' | 'credit'
  reserve(credential: string | undefined, route: RouteId, units: number): Promise<AccessDecision>
  settle(reservation: Reservation, outcome: Settlement): Promise<void>
}

// Relay credentials have their own prefixes. `hhl_` is a local prototype token; `hhk_` is reserved
// for the future paid service credential. Anything else is rejected without further checks.
const LOCAL_TOKEN = /^hhl_[A-Za-z0-9_-]{43}$/
const NOT_A_RELAY_CREDENTIAL = [
  /^hhr_/, // checkout recovery code
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // provider invoice / receipt id
  /^CP-[0-9A-F]{8}$/, // invoice memo code
  /^[0-9a-f]{64}$/i, // transaction id
]

export function newLocalToken(): string {
  return `hhl_${randomBytes(32).toString('base64url')}`
}

export function isLocalToken(value: string): boolean {
  return LOCAL_TOKEN.test(value)
}

export function looksLikeNonRelayCredential(value: string): boolean {
  return NOT_A_RELAY_CREDENTIAL.some((re) => re.test(value))
}

// `Authorization: Bearer <credential>` only. Never a URL, cookie or body.
export function bearerCredential(request: Request): string | undefined {
  const match = /^Bearer ([\x21-\x7e]{1,256})$/.exec(request.headers.get('authorization') ?? '')
  return match?.[1]
}

export const unavailableGate: RelayAccessGate = Object.freeze({
  kind: 'unavailable' as const,
  async reserve(): Promise<AccessDecision> {
    return { ok: false, reason: 'access_unavailable' }
  },
  async settle() {},
})

export interface LocalGateOptions {
  token: string
  // Token bucket: `burst` calls at once, refilled at `perMinute`.
  perMinute?: number
  burst?: number
  now?: () => number
}

export class LocalPrototypeGate implements RelayAccessGate {
  readonly kind = 'local-prototype' as const
  private readonly digest: Buffer
  private readonly perMinute: number
  private readonly burst: number
  private readonly now: () => number
  private tokens: number
  private last: number
  private readonly open = new Set<string>()
  // Counts only; no request data. Lets the demo show what a credit gate would have charged.
  readonly usage = { consumed: 0, released: 0 }

  constructor(options: LocalGateOptions) {
    if (!isLocalToken(options.token)) throw new Error('local relay token must be hhl_ followed by 43 base64url characters')
    this.digest = sha256(options.token)
    this.perMinute = options.perMinute ?? 30
    this.burst = options.burst ?? 5
    this.now = options.now ?? Date.now
    this.tokens = this.burst
    this.last = this.now()
  }

  async reserve(credential: string | undefined, route: RouteId, units: number): Promise<AccessDecision> {
    if (!credential) return { ok: false, reason: 'credential_required' }
    if (looksLikeNonRelayCredential(credential) || !isLocalToken(credential)) return { ok: false, reason: 'credential_rejected' }
    if (!timingSafeEqual(sha256(credential), this.digest)) return { ok: false, reason: 'credential_rejected' }
    const t = this.now()
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 60_000) * this.perMinute)
    this.last = t
    if (this.tokens < units) return { ok: false, reason: 'rate_limited' }
    this.tokens -= units
    const reservation = { id: randomBytes(12).toString('base64url'), route, units }
    this.open.add(reservation.id)
    return { ok: true, reservation }
  }

  async settle(reservation: Reservation, outcome: Settlement): Promise<void> {
    // Exactly once: a second settle for the same reservation is ignored.
    if (!this.open.delete(reservation.id)) return
    this.usage[outcome] += reservation.units
    // A call refused before contact gives its rate-limit slot back.
    if (outcome === 'released') this.tokens = Math.min(this.burst, this.tokens + reservation.units)
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
