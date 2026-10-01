// Minimal agent client for the local prototype relay. Node 24+, no dependencies.
//   npm run relay            (in another terminal)
//   node examples/relay/agent.mjs [itemId]
import { readFileSync } from 'node:fs'

const RELAY = process.env.RELAY_URL ?? 'http://127.0.0.1:8749'
const token = readFileSync(process.env.RELAY_TOKEN_FILE ?? '.relay-local/token', 'utf8').trim()

// Route names and parameters only. The relay never accepts a URL, so there is nothing to smuggle.
async function relay(path) {
  const res = await fetch(`${RELAY}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const body = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${body.error}`)
  return { mode: res.headers.get('hh-relay-mode'), route: res.headers.get('hh-relay-route'), body }
}

const status = await (await fetch(`${RELAY}/v1/status`)).json()
console.log(`relay mode: ${status.mode}`)
for (const line of status.privacyBoundary) console.log(`  - ${line}`)

const id = process.argv[2] ?? '8863'
const item = await relay(`/v1/hn/item/${id}`)
console.log(`${item.route} via ${item.mode}:`, { id: item.body?.id, type: item.body?.type, by: item.body?.by, title: item.body?.title })

const top = await relay('/v1/hn/topstories')
console.log(`${top.route}: ${top.body.length} ids, first ${top.body.slice(0, 3).join(', ')}`)

// A refused request, to show the failure contract.
const refused = await fetch(`${RELAY}/v1/hn/item/1?url=http://169.254.169.254/`, { headers: { authorization: `Bearer ${token}` } })
console.log('query smuggling attempt:', refused.status, await refused.json())
