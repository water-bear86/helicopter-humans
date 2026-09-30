// GET /api/status - service shell health check. Reports which payment adapter is active; never secrets.
import { getAdapter } from '../src/payments/registry.js'

export function GET(): Response {
  const adapter = getAdapter(process.env.PAYMENT_ADAPTER)
  return Response.json(
    {
      service: 'helicopter-humans',
      redactor: 'live-client-side',
      payments: { adapter: adapter.id, mode: adapter.mode, privacyNote: adapter.privacyNote },
    },
    { headers: { 'cache-control': 'no-store' } },
  )
}
