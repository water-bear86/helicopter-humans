// GET /api/status - service shell health check. Reports which payment adapter is active; never secrets.
import { CHECKOUT_BLOCKERS } from '../src/checkout/readiness.js'
import { getAdapter } from '../src/payments/registry.js'
import { RELAY_BLOCKERS } from '../src/relay/readiness.js'

export function GET(): Response {
  const adapter = getAdapter(process.env.PAYMENT_ADAPTER)
  return Response.json(
    {
      service: 'helicopter-humans',
      redactor: 'live-client-side',
      payments: {
        adapter: adapter.id,
        mode: adapter.mode,
        collecting: adapter.mode === 'live',
        blockers: adapter.blockers ?? [],
        privacyNote: adapter.privacyNote,
      },
      // Invoice checkout (api/checkout/*). Reported from code, never from configuration.
      checkout: {
        mode: 'disabled',
        collecting: false,
        blockers: CHECKOUT_BLOCKERS,
      },
      // Agent relay (src/relay/). A local prototype only; no deployment serves it.
      relay: {
        mode: 'unavailable',
        hosted: false,
        blockers: RELAY_BLOCKERS,
      },
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
