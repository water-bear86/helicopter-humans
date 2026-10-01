// Local prototype relay server. Binds loopback only and refuses to start on any host. Prints one
// startup line and nothing per request: no paths, credentials or upstream data are ever written out.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import { isLocalToken, LocalPrototypeGate, newLocalToken } from './access.js'
import { handleRelay, type RelayRuntime } from './handler.js'
import { relayMode } from './readiness.js'
import type { Env } from '../checkout/readiness.js'
import { createUpstreamClient } from './upstream.js'

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

export function createRelayServer(runtime: RelayRuntime): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (response: Response) =>
      response.arrayBuffer().then((body) => {
        res.statusCode = response.status
        response.headers.forEach((value, key) => res.setHeader(key, value))
        res.end(Buffer.from(body))
      })
    try {
      // A DNS-rebinding page reaches loopback under a foreign Host name; refuse it.
      if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return void (await send(Response.json({ error: 'host_refused' }, { status: 403 })))
      if (req.method !== 'GET') return void (await send(Response.json({ error: 'method_not_allowed' }, { status: 405 })))
      if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) > 0) {
        return void (await send(Response.json({ error: 'body_not_allowed' }, { status: 400 })))
      }
      const headers = new Headers()
      for (const name of ['authorization', 'origin', 'sec-fetch-site']) {
        const value = req.headers[name]
        if (typeof value === 'string') headers.set(name, value)
      }
      const request = new Request('http://127.0.0.1/', { method: req.method, headers })
      await send(await handleRelay(request, runtime, req.url ?? '/'))
    } catch {
      res.statusCode = 500
      res.end()
    }
  })
}

// The token lives in a 0600 file, not in output. RELAY_LOCAL_TOKEN overrides it for scripted use.
export function loadOrCreateLocalToken(env: Env, file: string): string {
  if (env.RELAY_LOCAL_TOKEN) {
    if (!isLocalToken(env.RELAY_LOCAL_TOKEN)) throw new Error('RELAY_LOCAL_TOKEN must be hhl_ followed by 43 base64url characters')
    return env.RELAY_LOCAL_TOKEN
  }
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (isLocalToken(existing)) return existing
  } catch {
    // Not created yet.
  }
  const token = newLocalToken()
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${token}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

export async function main(env: Env = process.env): Promise<void> {
  const mode = relayMode({ ...env, RELAY_MODE: 'local' })
  if (mode !== 'local-prototype') {
    console.error('Refusing to start: the relay runs only as a local prototype, never on a hosted deployment.')
    process.exitCode = 1
    return
  }
  const port = Number(env.RELAY_PORT ?? 8749)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('RELAY_PORT must be 1024-65535')
  const tokenFile = resolve(env.RELAY_TOKEN_FILE ?? '.relay-local/token')
  const gate = new LocalPrototypeGate({ token: loadOrCreateLocalToken(env, tokenFile) })
  const server = createRelayServer({ mode, gate, upstream: createUpstreamClient() })
  server.requestTimeout = 10_000
  server.headersTimeout = 5_000
  server.once('error', (error: NodeJS.ErrnoException) => {
    console.error(`Relay could not listen on 127.0.0.1:${port} (${error.code ?? 'error'}). Set RELAY_PORT to a free port.`)
    process.exitCode = 1
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`Helicopter Humans relay: LOCAL PROTOTYPE on http://127.0.0.1:${port} (loopback only). Token file: ${tokenFile}. Privacy boundary: GET /v1/status or docs/RELAY.md.`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}
