// One foreground read of the allowed public HN resource; no account, payment,
// stored credential, retained server or production change. Contacts the real upstream, so it runs
// only on request: `RELAY_LIVE_TEST=1 npx vitest run src/relay/review-live.test.ts`.
import { afterAll, describe, expect, it } from 'vitest'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { LocalPrototypeGate, newLocalToken } from './access'
import { createRelayServer } from './server'
import { createUpstreamClient } from './upstream'

let server: Server | undefined
afterAll(async () => {
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
  }
})

describe.skipIf(!process.env.RELAY_LIVE_TEST)('live relay read', () => {
  it('returns the real allowed public resource through the local relay', async () => {
    const token = newLocalToken()
    server = createRelayServer({ mode: 'local-prototype', gate: new LocalPrototypeGate({ token }), upstream: createUpstreamClient() })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const result = await fetch(`http://127.0.0.1:${port}/v1/hn/item/8863`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) })
    expect(result.status).toBe(200)
    expect(result.headers.get('hh-relay-mode')).toBe('local-prototype')
    expect(result.headers.get('set-cookie')).toBeNull()
    expect(await result.json()).toMatchObject({ id: 8863, type: 'story', title: 'My YC app: Dropbox - Throw away your USB drive' })
  }, 10000)
})
