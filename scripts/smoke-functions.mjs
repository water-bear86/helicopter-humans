// Exercises the functions emitted by `vercel build` (not the sources), so tracing and Node ESM
// import regressions fail here. Usage, after `vercel build`: node scripts/smoke-functions.mjs
// No network: global fetch is replaced with a recorder that refuses every call.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

const FN = '.vercel/output/functions/api'
const load = (path) => import(new URL(`../${FN}/${path}`, import.meta.url).href)
const [order, orders, status, quote] = await Promise.all([
  load('checkout/order.func/api/checkout/order.js'),
  load('checkout/orders.func/api/checkout/orders.js'),
  load('status.func/api/status.js'),
  load('pay/quote.func/api/pay/quote.js'),
])
assert.ok(existsSync(`${FN}/checkout/order.func/node_modules/pg`), 'pg must be traced into the checkout function')

const outbound = []
globalThis.fetch = async (url) => {
  outbound.push(String(url))
  throw new Error('network disabled in smoke test')
}

const ORIGIN = 'https://helicopter-humans.vercel.app'
const post = (path, body, code) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...(code ? { authorization: `Bearer ${code}` } : {}) },
  })
const get = (path, code) => new Request(`${ORIGIN}${path}`, { headers: code ? { authorization: `Bearer ${code}` } : {} })

function setEnv(env) {
  for (const k of ['VERCEL', 'VERCEL_ENV', 'NODE_ENV', 'CHECKOUT_MODE', 'CIPHERPAY_API_KEY', 'CHECKOUT_DATABASE_URL', 'PAYMENT_ADAPTER']) delete process.env[k]
  Object.assign(process.env, env)
}

// 1. Production with a complete-looking environment, in both modes someone might try.
const FULL = {
  VERCEL: '1',
  VERCEL_ENV: 'production',
  CIPHERPAY_API_KEY: 'cpay_sk_fixture_not_a_real_key',
  CHECKOUT_DATABASE_URL: 'postgres://u:p@db.example.com/checkout?sslmode=require',
  PAYMENT_ADAPTER: 'cipherpay-zcash-shielded',
}
const code = `hhr_${'A'.repeat(43)}`
for (const mode of ['live', 'fixture']) {
  setEnv({ ...FULL, CHECKOUT_MODE: mode })
  const responses = [
    await orders.GET(get('/api/checkout/orders')),
    await orders.POST(post('/api/checkout/orders', {})),
    await order.GET(get('/api/checkout/order', code)),
    await order.POST(post('/api/checkout/order', { action: 'create_invoice' }, code)),
    await order.POST(post('/api/checkout/order', { action: 'fixture_event', event: 'pay_full' }, code)),
    await quote.POST(new Request(`${ORIGIN}/api/pay/quote`, { method: 'POST', body: '{"productId":"founding-pass"}' })),
  ]
  for (const res of responses) {
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('payment-required'), null)
    const text = await res.text()
    assert.ok(!/u1[a-z0-9]{20,}|zcash:/.test(text), 'no address or payment URI')
  }
  const s = await (await status.GET()).json()
  assert.deepEqual(s.checkout, {
    mode: 'disabled',
    collecting: false,
    blockers: ['offer_not_approved', 'merchant_fee_config_unverified', 'durable_store_not_deployed', 'no_confirmed_payer', 'no_authorized_mainnet_e2e'],
  })
  console.log(`production, CHECKOUT_MODE=${mode}: all checkout and pay routes 503, status disabled`)
}
assert.deepEqual(outbound, [], 'no provider or network call while disabled')

// 2. Local fixture mode through the built bundles: proves each runtime import chain resolves.
// The two functions are separate bundles with separate in-memory stores, so an order created by one
// is invisible to the other. That is the reason memory is refused anywhere but a local fixture run.
setEnv({ CHECKOUT_MODE: 'fixture' })
assert.equal((await orders.GET(get('/api/checkout/orders'))).status, 200)
const createdRes = await orders.POST(post('/api/checkout/orders', {}))
assert.equal(createdRes.status, 201)
const created = await createdRes.json()
assert.match(created.recoveryCode, /^hhr_[A-Za-z0-9_-]{43}$/)
const elsewhere = await order.GET(get('/api/checkout/order', created.recoveryCode))
assert.equal(elsewhere.status, 404)
assert.deepEqual(await elsewhere.json(), { error: 'order_not_found' })
assert.deepEqual(outbound, [], 'fixture provider is in-process')
console.log('local fixture through built functions: order created (201); other bundle has its own memory store (404)')
