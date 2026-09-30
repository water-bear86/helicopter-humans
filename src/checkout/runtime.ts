// Decides, per request, whether the checkout exists at all. Three outcomes:
//   disabled - the default and the only outcome on any hosted deployment while CHECKOUT_BLOCKERS is
//              non-empty. Routes answer 503 before reading the body or touching any provider/store.
//   fixture  - local simulation (CHECKOUT_MODE=fixture, never hosted): memory store, simulated provider.
//   live     - unreachable until every blocker is removed in code; then requires CHECKOUT_MODE=live,
//              a PostgreSQL URL and a merchant key, and never falls back to memory.
import { CIPHERPAY_ORIGIN, createCipherPayClient } from './cipherpay.js'
import { createFixtureCipherPay, FIXTURE_API_KEY, FIXTURE_ORIGIN, type FixtureCipherPay } from './fixture-cipherpay.js'
import { DRAFT_OFFER, type Offer } from './offer.js'
import { CHECKOUT_BLOCKERS, checkoutMode, type Env } from './readiness.js'
import { createCheckoutService, type CheckoutService } from './service.js'
import { MemoryOrderStore, type OrderStore } from './store.js'
import { PostgresOrderStore } from './store-postgres.js'

export type CheckoutRuntime =
  | { mode: 'disabled'; blockers: readonly string[] }
  | { mode: 'fixture'; blockers: readonly string[]; offer: Offer; service: CheckoutService; provider: FixtureCipherPay; store: OrderStore }
  | { mode: 'live'; blockers: readonly string[]; offer: Offer; service: CheckoutService }

let fixture: Extract<CheckoutRuntime, { mode: 'fixture' }> | undefined
let live: Extract<CheckoutRuntime, { mode: 'live' }> | undefined

export function createFixtureRuntime(now?: () => number): Extract<CheckoutRuntime, { mode: 'fixture' }> {
  const provider = createFixtureCipherPay({ now })
  const store = new MemoryOrderStore()
  const client = createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: provider.fetch, allowLoopback: true, timeoutMs: 1500 })
  const service = createCheckoutService({ store, provider: client, offer: DRAFT_OFFER, now })
  return { mode: 'fixture', blockers: CHECKOUT_BLOCKERS, offer: DRAFT_OFFER, service, provider, store }
}

// Live composition. `blockers` is a parameter only so tests can prove the composition itself refuses
// a missing database or key; routes always go through resolveCheckout, which passes the real list.
export function liveCheckoutFromEnv(env: Env, blockers: readonly string[] = CHECKOUT_BLOCKERS): CheckoutService {
  if (blockers.length > 0) throw new Error(`checkout is not ready: ${blockers.join(', ')}`)
  if (!env.CHECKOUT_DATABASE_URL) throw new Error('CHECKOUT_DATABASE_URL is required; there is no non-durable fallback')
  if (!env.CIPHERPAY_API_KEY) throw new Error('CIPHERPAY_API_KEY is required')
  const store = new PostgresOrderStore({ connectionString: env.CHECKOUT_DATABASE_URL })
  const client = createCipherPayClient({ origin: CIPHERPAY_ORIGIN, apiKey: env.CIPHERPAY_API_KEY })
  return createCheckoutService({ store, provider: client, offer: DRAFT_OFFER })
}

export function resolveCheckout(env: Env): CheckoutRuntime {
  if (checkoutMode(env) === 'fixture') return (fixture ??= createFixtureRuntime())
  // Code, not configuration: with any blocker left, no environment reaches the live branch.
  if (CHECKOUT_BLOCKERS.length > 0 || env.CHECKOUT_MODE !== 'live') return { mode: 'disabled', blockers: CHECKOUT_BLOCKERS }
  return (live ??= { mode: 'live', blockers: CHECKOUT_BLOCKERS, offer: DRAFT_OFFER, service: liveCheckoutFromEnv(env) })
}
