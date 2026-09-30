// The checkout's live-readiness guard. Like liveReadiness() for the x402 path, these are code, not
// configuration: no environment variable, however complete, can clear one. Each is removed by the
// change that supplies its evidence.
export const CHECKOUT_BLOCKERS = Object.freeze([
  // Angus has not approved the US$9 Founding Agent Pass terms. src/checkout/offer.ts is a draft.
  'offer_not_approved',
  // No merchant account, receiving wallet ownership or actual fee rate has been confirmed, and the
  // provider may add a fee recipient to the payment URI, which this checkout rejects.
  'merchant_fee_config_unverified',
  // The PostgreSQL order store and migrations exist but are not deployed to an approved database.
  'durable_store_not_deployed',
  // No released wallet has been shown to pay one of these invoices with a fully shielded spend.
  'no_confirmed_payer',
  // No explicitly authorized, capped mainnet payment has been run through this code.
  'no_authorized_mainnet_e2e',
] as const)

export type Env = Record<string, string | undefined>

export type CheckoutMode = 'disabled' | 'fixture'

// Any sign that this code is running on a host rather than a developer machine. Vercel sets VERCEL=1
// and VERCEL_ENV on every build and function invocation, preview included.
export function isHosted(env: Env): boolean {
  return Boolean(env.VERCEL || env.VERCEL_ENV || env.NODE_ENV === 'production')
}

// `fixture` is a local simulation: in-memory store, simulated provider, fake unpayable addresses.
// It is refused on any hosted deployment. Everything else is `disabled` while blockers remain.
export function checkoutMode(env: Env): CheckoutMode {
  if (env.CHECKOUT_MODE === 'fixture' && !isHosted(env)) return 'fixture'
  return 'disabled'
}
