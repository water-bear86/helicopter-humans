// Request handling for the relay. Order matters: everything that can be refused without the network
// is refused first, then one call is reserved, then the upstream is contacted once, then the
// reservation is settled. Nothing here logs request data or upstream bodies.
import { bearerCredential, type AccessRefusal, type RelayAccessGate } from './access.js'
import { PRIVACY_BOUNDARY, RELAY_BLOCKERS, type RelayMode } from './readiness.js'
import { matchRoute, PRODUCTION_ROUTE_OPTIONS, ROUTE_IDS, type RouteOptions } from './routes.js'
import type { UpstreamClient, UpstreamFailure } from './upstream.js'

export interface RelayRuntime {
  mode: RelayMode
  gate: RelayAccessGate
  upstream: UpstreamClient
  routes?: RouteOptions
  maxConcurrent?: number
}

const HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

function respond(body: unknown, status: number, mode: RelayMode): Response {
  return Response.json(body, { status, headers: { ...HEADERS, 'hh-relay-mode': mode } })
}

const ACCESS_STATUS: Record<AccessRefusal, number> = {
  credential_required: 401,
  credential_rejected: 403,
  insufficient_credit: 402,
  rate_limited: 429,
  access_unavailable: 503,
}

const UPSTREAM_STATUS: Record<UpstreamFailure, number> = {
  destination_refused: 502,
  dns_failed: 502,
  connect_failed: 502,
  upstream_timeout: 504,
  upstream_redirect_refused: 502,
  upstream_status: 502,
  upstream_content_type: 502,
  upstream_encoding: 502,
  upstream_too_large: 502,
  upstream_malformed: 502,
}

const inFlight = new WeakMap<RelayRuntime, number>()

export async function handleRelay(request: Request, runtime: RelayRuntime, rawPath: string): Promise<Response> {
  const { mode } = runtime
  if (mode === 'unavailable') return respond({ error: 'relay_unavailable' }, 503, mode)
  if (request.method !== 'GET') return respond({ error: 'method_not_allowed' }, 405, mode)
  // Agents call the relay directly. A browser page on any site could also reach a loopback server, so
  // anything carrying an Origin or a cross-site fetch marker is refused before any other check.
  const site = request.headers.get('sec-fetch-site')
  if (request.headers.has('origin') || (site && site !== 'none')) return respond({ error: 'browser_request_refused' }, 403, mode)

  if (rawPath === '/v1/status') {
    return respond({ service: 'helicopter-humans-relay', mode, routes: ROUTE_IDS, blockers: RELAY_BLOCKERS, privacyBoundary: PRIVACY_BOUNDARY }, 200, mode)
  }
  const route = matchRoute(rawPath, runtime.routes ?? PRODUCTION_ROUTE_OPTIONS)
  if (route === 'query_not_allowed') return respond({ error: 'query_not_allowed' }, 400, mode)
  if (route === 'route_not_found') return respond({ error: 'route_not_found' }, 404, mode)

  const decision = await runtime.gate.reserve(bearerCredential(request), route.id, 1)
  if (!decision.ok) return respond({ error: decision.reason }, ACCESS_STATUS[decision.reason], mode)
  const { reservation } = decision

  const busy = inFlight.get(runtime) ?? 0
  if (busy >= (runtime.maxConcurrent ?? 4)) {
    await runtime.gate.settle(reservation, 'released')
    return respond({ error: 'relay_busy' }, 429, mode)
  }
  inFlight.set(runtime, busy + 1)
  let result: Awaited<ReturnType<UpstreamClient['get']>>
  try {
    result = await runtime.upstream.get(route.target)
  } finally {
    inFlight.set(runtime, (inFlight.get(runtime) ?? 1) - 1)
  }
  await runtime.gate.settle(reservation, result.ok || result.contacted ? 'consumed' : 'released')

  if (!result.ok) {
    return respond({ error: result.reason, route: route.id, ...(result.status ? { upstreamStatus: result.status } : {}) }, UPSTREAM_STATUS[result.reason], mode)
  }
  // Only this header set reaches the caller; no upstream header is copied.
  return new Response(new Uint8Array(result.body), {
    status: 200,
    headers: { ...HEADERS, 'content-type': 'application/json; charset=utf-8', 'hh-relay-mode': mode, 'hh-relay-route': route.id },
  })
}
