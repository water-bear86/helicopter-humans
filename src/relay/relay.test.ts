import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as status } from '../../api/status'
import { LocalPrototypeGate, newLocalToken, unavailableGate } from './access'
import { isPublicAddress } from './destination'
import { handleRelay, type RelayRuntime } from './handler'
import { PRIVACY_BOUNDARY, RELAY_BLOCKERS, relayMode } from './readiness'
import { HN_UPSTREAM, matchRoute, type RouteOptions } from './routes'
import { createRelayServer, loadOrCreateLocalToken } from './server'
import { createUpstreamClient, RELAY_USER_AGENT, type Resolver } from './upstream'

// Local fixture upstream. It records what reached it and answers per path. No external network.
type Reply = { status?: number; headers?: Record<string, string>; body?: string | Buffer; hang?: boolean; chunks?: number }
const seen: IncomingHttpHeaders[] = []
let replies: Record<string, Reply> = {}
let upstream: Server
let upstreamPort = 0

beforeAll(async () => {
  upstream = createServer((req, res) => {
    seen.push(req.headers)
    const reply = replies[req.url ?? ''] ?? { status: 404, headers: { 'content-type': 'application/json' }, body: 'null' }
    if (reply.hang) return
    res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers })
    if (reply.chunks) {
      for (let i = 0; i < reply.chunks; i++) res.write(Buffer.alloc(1024, 32))
      return void res.end()
    }
    res.end(reply.body ?? '{}')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as AddressInfo).port
})
afterAll(() => {
  upstream.closeAllConnections()
  upstream.close()
})
afterEach(() => {
  seen.length = 0
  replies = {}
})

const loopbackResolver: Resolver = async () => [{ address: '127.0.0.1', family: 4 }]
const fixtureRoutes = (): RouteOptions => ({ upstream: { host: 'hn.fixture.test', basePath: '/v0' }, scheme: 'http:', port: upstreamPort })

function fixtureRuntime(overrides: Partial<RelayRuntime> & { token?: string; timeoutMs?: number; maxBytes?: number; resolver?: Resolver } = {}) {
  const token = overrides.token ?? newLocalToken()
  const gate = new LocalPrototypeGate({ token, burst: 50, perMinute: 600 })
  const runtime: RelayRuntime = {
    mode: 'local-prototype',
    gate,
    upstream: createUpstreamClient({ fixtureLoopback: true, resolver: overrides.resolver ?? loopbackResolver, timeoutMs: overrides.timeoutMs ?? 1000, maxBytes: overrides.maxBytes ?? 4096 }),
    routes: fixtureRoutes(),
    ...overrides,
  }
  return { runtime, token, gate }
}

const get = (token?: string, headers: Record<string, string> = {}) =>
  new Request('http://127.0.0.1/', { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } })

describe('destination policy', () => {
  it.each([
    '10.0.0.1', '127.0.0.1', '127.255.255.254', '0.0.0.0', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
    '198.18.0.1', '192.0.2.1', '203.0.113.9', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2001:db8::1', '2002:a00:1::1', '2001:0:4136:e378::1', 'ff02::1', 'not-an-ip', '',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['151.101.1.1', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '2a00:1450:4001::1'])('allows public %s', (address) => {
    expect(isPublicAddress(address)).toBe(true)
  })
})

describe('route table', () => {
  it('maps only fixed paths to the fixed HTTPS upstream', () => {
    const item = matchRoute('/v1/hn/item/8863')
    expect(item).toMatchObject({ id: 'hn.item' })
    expect(typeof item !== 'string' && item.target.href).toBe(`https://${HN_UPSTREAM.host}/v0/item/8863.json`)
    const top = matchRoute('/v1/hn/topstories')
    expect(typeof top !== 'string' && top.target.href).toBe('https://hacker-news.firebaseio.com/v0/topstories.json')
  })

  it.each([
    ['/v1/hn/item/1?print=pretty', 'query_not_allowed'],
    ['/v1/hn/item/1?', 'query_not_allowed'],
    ['/v1/hn/item/1#x', 'query_not_allowed'],
    ['/v1/hn/item/01', 'route_not_found'],
    ['/v1/hn/item/12345678901', 'route_not_found'],
    ['/v1/hn/item/1.json', 'route_not_found'],
    ['/v1/hn/item/%31', 'route_not_found'],
    ['/v1/hn/item/../../user/pg', 'route_not_found'],
    ['/v1/hn//topstories', 'route_not_found'],
    ['/v1/hn/topstories/', 'route_not_found'],
    ['//evil.example/v0/item/1.json', 'route_not_found'],
    ['http://169.254.169.254/latest/meta-data', 'route_not_found'],
    ['/v1/hn/user/pg', 'route_not_found'],
  ])('refuses %s', (path, reason) => {
    expect(matchRoute(path)).toBe(reason)
  })
})

describe('upstream client', () => {
  it('refuses a private DNS answer before connecting, including one private answer among public ones', async () => {
    const answers: Array<Awaited<ReturnType<Resolver>>> = [
      [{ address: '10.0.0.5', family: 4 }],
      [{ address: '169.254.169.254', family: 4 }],
      [{ address: '151.101.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
      [{ address: '::ffff:127.0.0.1', family: 6 }],
      [{ address: 'fd00::1', family: 6 }],
      [],
    ]
    for (const answer of answers) {
      const client = createUpstreamClient({ resolver: async () => answer, timeoutMs: 1000 })
      const result = await client.get(new URL('https://hacker-news.firebaseio.com/v0/maxitem.json'))
      expect(result).toEqual({ ok: false, reason: answer.length ? 'destination_refused' : 'dns_failed', contacted: false })
    }
  })

  it('checks DNS on every request, so a rebinding answer is refused on the next call', async () => {
    replies['/v0/maxitem.json'] = { body: '42' }
    const answers = [[{ address: '127.0.0.1', family: 4 as const }], [{ address: '10.1.2.3', family: 4 as const }]]
    const client = createUpstreamClient({ fixtureLoopback: true, resolver: async () => answers.shift()!, timeoutMs: 1000 })
    const target = new URL(`http://hn.fixture.test:${upstreamPort}/v0/maxitem.json`)
    expect(await client.get(target)).toMatchObject({ ok: true, status: 200 })
    expect(await client.get(target)).toEqual({ ok: false, reason: 'destination_refused', contacted: false })
    expect(seen).toHaveLength(1)
  })

  it('refuses IP-literal, userinfo, query, fragment, non-default-port and non-HTTPS targets without a lookup', async () => {
    const resolver = vi.fn(loopbackResolver)
    const client = createUpstreamClient({ resolver })
    for (const href of [
      'https://151.101.1.1/v0/item/1.json',
      'https://[2606:4700::1111]/v0/item/1.json',
      'https://u:p@hacker-news.firebaseio.com/v0/item/1.json',
      'https://hacker-news.firebaseio.com/v0/item/1.json?x=1',
      'https://hacker-news.firebaseio.com/v0/item/1.json#f',
      'https://hacker-news.firebaseio.com:8443/v0/item/1.json',
      'http://hacker-news.firebaseio.com/v0/item/1.json',
    ]) {
      expect(await client.get(new URL(href))).toEqual({ ok: false, reason: 'destination_refused', contacted: false })
    }
    expect(resolver).not.toHaveBeenCalled()
  })
})

describe('relay handler against the local fixture upstream', () => {
  it('fetches the allowed resource and returns only the relay header contract', async () => {
    const { runtime, token, gate } = fixtureRuntime()
    replies['/v0/item/8863.json'] = { body: '{"id":8863,"type":"story"}', headers: { 'set-cookie': 'track=1', 'x-upstream-secret': 'nope', server: 'fixture' } }
    const res = await handleRelay(get(token), runtime, '/v1/hn/item/8863')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: 8863, type: 'story' })
    expect([...res.headers.keys()].sort()).toEqual(
      ['cache-control', 'content-type', 'hh-relay-mode', 'hh-relay-route', 'referrer-policy', 'x-content-type-options'].sort(),
    )
    expect(res.headers.get('hh-relay-mode')).toBe('local-prototype')
    expect(gate.usage).toEqual({ consumed: 1, released: 0 })
  })

  it('does not forward any caller header upstream', async () => {
    const { runtime, token } = fixtureRuntime()
    replies['/v0/maxitem.json'] = { body: '1' }
    const server = createRelayServer(runtime)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const leaky = {
      authorization: `Bearer ${token}`,
      cookie: 'session=caller-cookie',
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
      forwarded: 'for=203.0.113.7',
      'true-client-ip': '203.0.113.7',
      'cf-connecting-ip': '203.0.113.7',
      referer: 'https://caller.example/secret-page',
      'user-agent': 'CallerAgent/9.9 (host=caller-laptop)',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'caller=1',
      'x-request-id': 'caller-request-id',
      'x-amzn-trace-id': 'Root=1-caller',
      'x-b3-traceid': 'caller-b3',
      'x-caller-marker': 'caller-marker-value',
      'accept-language': 'en-NZ',
    }
    const status = await new Promise<number>((resolve, reject) => {
      const r = httpRequest({ host: '127.0.0.1', port, path: '/v1/hn/maxitem', headers: leaky }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      r.on('error', reject)
      r.end()
    })
    server.close()
    expect(status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0]).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent'])
    expect(seen[0]['user-agent']).toBe(RELAY_USER_AGENT)
    expect(seen[0].host).toBe(`hn.fixture.test:${upstreamPort}`)
    const text = JSON.stringify(seen[0])
    for (const value of Object.values(leaky)) expect(text).not.toContain(value)
  })

  it.each([
    [{ status: 302, headers: { location: 'http://169.254.169.254/' } }, 'upstream_redirect_refused', 502],
    [{ status: 500 }, 'upstream_status', 502],
    [{ headers: { 'content-type': 'text/html' }, body: '<html>' }, 'upstream_content_type', 502],
    [{ headers: { 'content-encoding': 'gzip' } }, 'upstream_encoding', 502],
    [{ headers: { 'content-length': '999999' }, body: '' }, 'upstream_too_large', 502],
    [{ chunks: 8 }, 'upstream_too_large', 502],
    [{ body: '{"half":' }, 'upstream_malformed', 502],
    [{ hang: true }, 'upstream_timeout', 504],
  ] as const)('refuses %j as %s, once, and charges the contacted call', async (reply, error, code) => {
    const { runtime, token, gate } = fixtureRuntime({ timeoutMs: 300 })
    replies['/v0/topstories.json'] = reply as Reply
    const res = await handleRelay(get(token), runtime, '/v1/hn/topstories')
    expect(res.status).toBe(code)
    expect((await res.json()).error).toBe(error)
    expect(res.headers.get('location')).toBeNull()
    expect(seen).toHaveLength(1) // no retry, no redirect follow
    expect(gate.usage).toEqual({ consumed: 1, released: 0 })
  })

  it('releases the reservation when the destination is refused before contact', async () => {
    const { runtime, token, gate } = fixtureRuntime({ resolver: async () => [{ address: '192.168.0.10', family: 4 }] })
    const res = await handleRelay(get(token), runtime, '/v1/hn/maxitem')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toBe('destination_refused')
    expect(gate.usage).toEqual({ consumed: 0, released: 1 })
    expect(seen).toHaveLength(0)
  })
})

describe('relay access and isolation', () => {
  const upstreamSpy = { get: vi.fn() }
  afterEach(() => upstreamSpy.get.mockReset())
  const spyRuntime = (gate = new LocalPrototypeGate({ token: newLocalToken() })): RelayRuntime => ({ mode: 'local-prototype', gate, upstream: upstreamSpy })

  it('unavailable mode answers 503 before any access check or upstream call', async () => {
    const reserve = vi.fn(unavailableGate.reserve)
    const gate = { ...unavailableGate, reserve }
    const res = await handleRelay(get(newLocalToken()), { mode: 'unavailable', gate, upstream: upstreamSpy }, '/v1/hn/maxitem')
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'relay_unavailable' })
    expect(reserve).not.toHaveBeenCalled()
    expect(upstreamSpy.get).not.toHaveBeenCalled()
  })

  it('requires the local token; recovery codes, invoice ids, memo codes and txids are not relay credentials', async () => {
    const token = newLocalToken()
    const runtime = spyRuntime(new LocalPrototypeGate({ token }))
    const cases: Array<[string | undefined, number, string]> = [
      [undefined, 401, 'credential_required'],
      [`hhr_${'A'.repeat(43)}`, 403, 'credential_rejected'],
      ['3f2504e0-4f89-41d3-9a0c-0305e82c3301', 403, 'credential_rejected'],
      ['CP-0A1B2C3D', 403, 'credential_rejected'],
      ['a'.repeat(64), 403, 'credential_rejected'],
      [newLocalToken(), 403, 'credential_rejected'],
      [`hhk_${'A'.repeat(43)}`, 403, 'credential_rejected'],
    ]
    for (const [credential, code, error] of cases) {
      const res = await handleRelay(get(credential), runtime, '/v1/hn/maxitem')
      expect([res.status, (await res.json()).error]).toEqual([code, error])
    }
    // The token in a query string is refused as a query, never read.
    expect((await handleRelay(get(), runtime, `/v1/hn/maxitem?token=${token}`)).status).toBe(400)
    expect(upstreamSpy.get).not.toHaveBeenCalled()
  })

  it('refuses browsers, non-GET methods and unknown routes before touching the gate', async () => {
    const gate = new LocalPrototypeGate({ token: newLocalToken() })
    const reserve = vi.spyOn(gate, 'reserve')
    const runtime = spyRuntime(gate)
    expect((await handleRelay(get(undefined, { origin: 'https://evil.example' }), runtime, '/v1/hn/maxitem')).status).toBe(403)
    expect((await handleRelay(get(undefined, { 'sec-fetch-site': 'cross-site' }), runtime, '/v1/hn/maxitem')).status).toBe(403)
    expect((await handleRelay(new Request('http://127.0.0.1/', { method: 'POST', body: '{}' }), runtime, '/v1/hn/maxitem')).status).toBe(405)
    expect((await handleRelay(get(), runtime, '/v1/anything')).status).toBe(404)
    expect(reserve).not.toHaveBeenCalled()
  })

  it('rate limits per token and gives the slot back when a call never reached the upstream', async () => {
    let t = 0
    const token = newLocalToken()
    const gate = new LocalPrototypeGate({ token, burst: 2, perMinute: 6, now: () => t })
    upstreamSpy.get.mockResolvedValue({ ok: true, status: 200, body: Buffer.from('1') })
    const runtime = spyRuntime(gate)
    expect((await handleRelay(get(token), runtime, '/v1/hn/maxitem')).status).toBe(200)
    expect((await handleRelay(get(token), runtime, '/v1/hn/maxitem')).status).toBe(200)
    expect((await handleRelay(get(token), runtime, '/v1/hn/maxitem')).status).toBe(429)
    t += 10_000
    upstreamSpy.get.mockResolvedValueOnce({ ok: false, reason: 'dns_failed', contacted: false })
    expect((await handleRelay(get(token), runtime, '/v1/hn/maxitem')).status).toBe(502)
    expect((await handleRelay(get(token), runtime, '/v1/hn/maxitem')).status).toBe(200)
    expect(gate.usage).toEqual({ consumed: 3, released: 1 })
  })

  it('caps concurrent upstream calls', async () => {
    const token = newLocalToken()
    let release: () => void = () => {}
    upstreamSpy.get.mockImplementation(() => new Promise((resolve) => (release = () => resolve({ ok: true, status: 200, body: Buffer.from('1') }))))
    const runtime: RelayRuntime = { ...spyRuntime(new LocalPrototypeGate({ token })), maxConcurrent: 1 }
    const first = handleRelay(get(token), runtime, '/v1/hn/maxitem')
    await vi.waitFor(() => expect(upstreamSpy.get).toHaveBeenCalledTimes(1))
    const second = await handleRelay(get(token), runtime, '/v1/hn/maxitem')
    expect([second.status, (await second.json()).error]).toEqual([429, 'relay_busy'])
    release()
    expect((await first).status).toBe(200)
  })

  it('status states the privacy boundary and blockers without claiming anonymity', async () => {
    const res = await handleRelay(get(), spyRuntime(), '/v1/status')
    const body = await res.json()
    expect(body).toMatchObject({ mode: 'local-prototype', routes: ['hn.item', 'hn.topstories', 'hn.maxitem'], blockers: [...RELAY_BLOCKERS] })
    expect(body.privacyBoundary).toEqual([...PRIVACY_BOUNDARY])
    const text = JSON.stringify(body).toLowerCase()
    expect(text).toContain('not anonymity')
    expect(text).not.toMatch(/\bno logs\b|\bfully anonymous\b|\bis anonymous\b/)
  })
})

describe('relay placement', () => {
  it('is unavailable on every hosted environment whatever the configuration says', () => {
    for (const env of [{ VERCEL: '1' }, { VERCEL_ENV: 'preview' }, { NODE_ENV: 'production' }]) {
      expect(relayMode({ ...env, RELAY_MODE: 'local' })).toBe('unavailable')
    }
    expect(relayMode({})).toBe('unavailable')
    expect(relayMode({ RELAY_MODE: 'live' })).toBe('unavailable')
    expect(relayMode({ RELAY_MODE: 'local' })).toBe('local-prototype')
    // Clearing the blockers in code does not silently turn the local prototype into a hosted relay.
    expect(relayMode({ RELAY_MODE: 'local' }, [])).toBe('unavailable')
  })

  it('the local server refuses a non-loopback Host (DNS rebinding) and request bodies', async () => {
    const { runtime } = fixtureRuntime()
    const server = createRelayServer(runtime)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const call = (headers: Record<string, string>, method = 'GET', body?: string) =>
      new Promise<number>((resolve, reject) => {
        const r = httpRequest({ host: '127.0.0.1', port, path: '/v1/status', method, headers }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
        r.on('error', reject)
        r.end(body)
      })
    expect(await call({ host: 'rebind.attacker.example' })).toBe(403)
    expect(await call({ host: `127.0.0.1:${port}` })).toBe(200)
    expect(await call({ host: `localhost:${port}`, 'content-type': 'application/json' }, 'GET', '{"url":"http://10.0.0.1"}')).toBe(400)
    expect(await call({ host: `localhost:${port}` }, 'DELETE')).toBe(405)
    server.close()
    expect(seen).toHaveLength(0)
  })

  it('writes a generated token to a 0600 file and rejects a malformed override', async () => {
    const { mkdtempSync, statSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const file = join(mkdtempSync(join(tmpdir(), 'hh-relay-')), 'sub', 'token')
    const token = loadOrCreateLocalToken({}, file)
    expect(token).toMatch(/^hhl_[A-Za-z0-9_-]{43}$/)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8').trim()).toBe(token)
    expect(loadOrCreateLocalToken({}, file)).toBe(token)
    expect(() => loadOrCreateLocalToken({ RELAY_LOCAL_TOKEN: 'hhr_nope' }, file)).toThrow(/RELAY_LOCAL_TOKEN/)
  })

  it('the deployed status reports the relay as unavailable with its blockers', async () => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('RELAY_MODE', 'local')
    const body = await status().json()
    vi.unstubAllEnvs()
    expect(body.relay).toEqual({ mode: 'unavailable', hosted: false, blockers: [...RELAY_BLOCKERS] })
  })
})
