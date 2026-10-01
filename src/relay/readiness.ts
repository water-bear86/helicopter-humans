// Where the relay may run. Like CHECKOUT_BLOCKERS, these are code, not configuration: no environment
// variable can clear one. While any remains, a hosted runtime gets `unavailable` and the relay only
// runs as a local prototype on a developer machine, bound to loopback.
import { isHosted, type Env } from '../checkout/readiness.js'

export const RELAY_BLOCKERS = Object.freeze([
  // No paid relay credential exists. The local token is a single-operator prototype credential.
  'no_authenticated_entitlement',
  // No durable, atomic per-call credit accounting. The local gate counts in memory only.
  'no_credit_accounting',
  // Rate limits are per process. A hosted relay needs limits that hold across instances.
  'no_hosted_rate_limit',
  // Hosting, access controls and the operator's own traffic visibility have not been reviewed.
  'hosted_deployment_unreviewed',
] as const)

export type RelayMode = 'unavailable' | 'local-prototype'

export function relayMode(env: Env, blockers: readonly string[] = RELAY_BLOCKERS): RelayMode {
  if (isHosted(env)) return 'unavailable'
  if (env.RELAY_MODE !== 'local') return 'unavailable'
  // A future hosted mode is added by the change that clears the blockers; until then local only.
  return blockers.length > 0 ? 'local-prototype' : 'unavailable'
}

// What the relay tells callers about itself, on /v1/status and in docs/RELAY.md. Plain statements of
// what is and is not omitted, not an anonymity or no-logging claim.
export const PRIVACY_BOUNDARY = Object.freeze([
  "The upstream sees a connection from the relay host's IP address, not the caller's.",
  "The relay builds outgoing headers from scratch: it does not forward the caller's cookies, authorization, forwarded-for or real-IP headers, referrer, user-agent, tracking or trace identifiers.",
  'The operator and the host of the relay can observe traffic to and from it, including request paths and upstream responses. This is not anonymity from the operator or the host, and it does not hide agent content from them.',
  'What an agent asks for can itself identify it. Request content is not anonymised.',
  'The relay does not make a public x402 payment private and does not perform a Zcash swap.',
  "The relay code does not log request paths, credentials or upstream bodies. That says nothing about the host's own logs.",
])
