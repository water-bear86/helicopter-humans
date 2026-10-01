// The only way the relay reaches the network: one GET to a route-built URL, with headers built from
// scratch. Nothing from the caller's request (cookies, authorization, forwarded IPs, referrer, trace
// ids, user-agent) is available here to forward.
//
// SSRF controls:
// - The destination address is checked inside the socket's own DNS lookup, so the address that
//   passed the check is the address connected to, on every request. No DNS answer is cached here.
//   Every returned address must be public; one private answer refuses the whole request.
// - Route hosts are names, never IP literals (an IP literal would skip the lookup). Enforced below.
// - The connected peer address is checked again once the socket connects.
// - Redirects are never followed; any 3xx is refused. No proxy environment variable is consulted.
// - Bounded: one attempt (no retries), a total deadline and a response byte cap on the raw bytes
//   (identity encoding requested; any compressed response is refused rather than inflated).
import { lookup as dnsLookup } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP, type LookupFunction, type Socket } from 'node:net'
import { isLoopbackAddress, isPublicAddress } from './destination.js'

export const RELAY_USER_AGENT = 'helicopter-humans-relay/0.1'

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

export type UpstreamFailure =
  | 'destination_refused'
  | 'dns_failed'
  | 'connect_failed'
  | 'upstream_timeout'
  | 'upstream_redirect_refused'
  | 'upstream_status'
  | 'upstream_content_type'
  | 'upstream_encoding'
  | 'upstream_too_large'
  | 'upstream_malformed'

export type UpstreamResult =
  | { ok: true; status: number; body: Buffer }
  // `contacted` is true once a connection to the upstream was established: later credit accounting
  // charges for contacted requests and releases the rest.
  | { ok: false; reason: UpstreamFailure; contacted: boolean; status?: number }

export interface UpstreamClient {
  get(target: URL): Promise<UpstreamResult>
}

export interface UpstreamOptions {
  resolver?: Resolver
  timeoutMs?: number
  maxBytes?: number
  // Tests only: plain http to a loopback fixture server. Never selected by configuration.
  fixtureLoopback?: boolean
}

const defaultResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true })
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }))
}

class Refused extends Error {
  constructor(readonly reason: UpstreamFailure) {
    super(reason)
  }
}

export function createUpstreamClient(options: UpstreamOptions = {}): UpstreamClient {
  const resolver = options.resolver ?? defaultResolver
  const timeoutMs = options.timeoutMs ?? 5000
  const maxBytes = options.maxBytes ?? 256 * 1024
  const fixture = options.fixtureLoopback === true
  const allowed = fixture ? isLoopbackAddress : isPublicAddress

  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    resolver(hostname).then(
      (answers) => {
        if (answers.length === 0) return callback(new Refused('dns_failed'), '', 4)
        if (!answers.every((a) => allowed(a.address))) return callback(new Refused('destination_refused'), '', 4)
        if (lookupOptions.all) return (callback as unknown as (e: null, a: ResolvedAddress[]) => void)(null, answers)
        callback(null, answers[0].address, answers[0].family)
      },
      () => callback(new Refused('dns_failed'), '', 4),
    )
  }

  return {
    get(target) {
      return new Promise<UpstreamResult>((resolve) => {
        const expectedProtocol = fixture ? 'http:' : 'https:'
        if (target.protocol !== expectedProtocol || target.username || target.password || target.search || target.hash || isIP(target.hostname) || target.hostname.startsWith('[')) {
          return resolve({ ok: false, reason: 'destination_refused', contacted: false })
        }
        if (!fixture && target.port !== '') return resolve({ ok: false, reason: 'destination_refused', contacted: false })

        let contacted = false
        let settled = false
        const finish = (result: UpstreamResult) => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          resolve(result)
        }
        const fail = (reason: UpstreamFailure, status?: number) => finish({ ok: false, reason, contacted, ...(status === undefined ? {} : { status }) })

        const request = (fixture ? http : https).request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (fixture ? 80 : 443),
          path: target.pathname,
          method: 'GET',
          // The complete outgoing header set. Host is added by Node from `hostname`.
          headers: { accept: 'application/json', 'accept-encoding': 'identity', 'user-agent': RELAY_USER_AGENT, connection: 'close' },
          lookup,
          agent: false,
          ...(fixture ? {} : { servername: target.hostname }),
        })
        const deadline = setTimeout(() => {
          fail('upstream_timeout')
          request.destroy()
        }, timeoutMs)

        request.on('socket', (socket: Socket) => {
          socket.once('connect', () => {
            if (!allowed(socket.remoteAddress ?? '')) {
              fail('destination_refused')
              request.destroy()
              return
            }
            contacted = true
          })
        })
        request.on('error', (error) => {
          if (error instanceof Refused) return fail(error.reason)
          fail(contacted ? 'upstream_malformed' : 'connect_failed')
        })
        request.on('response', (response) => {
          const status = response.statusCode ?? 0
          const drop = (reason: UpstreamFailure) => {
            fail(reason, status)
            response.destroy()
            request.destroy()
          }
          if (status >= 300 && status < 400) return drop('upstream_redirect_refused')
          if (status !== 200) return drop('upstream_status')
          const type = (response.headers['content-type'] ?? '').toLowerCase()
          if (!/^application\/json(\s*;|$)/.test(type)) return drop('upstream_content_type')
          const encoding = (response.headers['content-encoding'] ?? 'identity').toLowerCase()
          if (encoding !== 'identity') return drop('upstream_encoding')
          const declared = Number(response.headers['content-length'])
          if (Number.isFinite(declared) && declared > maxBytes) return drop('upstream_too_large')

          const chunks: Buffer[] = []
          let total = 0
          response.on('data', (chunk: Buffer) => {
            total += chunk.byteLength
            if (total > maxBytes) return drop('upstream_too_large')
            chunks.push(chunk)
          })
          response.on('error', () => fail('upstream_malformed', status))
          response.on('end', () => {
            if (settled) return
            const body = Buffer.concat(chunks)
            try {
              JSON.parse(body.toString('utf8'))
            } catch {
              return fail('upstream_malformed', status)
            }
            finish({ ok: true, status, body })
          })
        })
        request.end()
      })
    },
  }
}
