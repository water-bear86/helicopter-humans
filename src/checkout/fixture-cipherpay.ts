// Simulated CipherPay API for local fixtures and tests, shaped after the pinned upstream source
// (f6f022db): create returns float `price_zec` and no integer amount; the public GET carries
// `price_zatoshis`/`received_zatoshis`; a fee config adds `address.1`/`amount.1`/`memo.1` to the URI.
// It is a `fetch` implementation, so fixtures exercise the real client, parser and URI checks.
//
// Addresses are Bech32m strings with a deliberately broken checksum: no wallet will pay them.
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, randomUUID } from 'node:crypto'
import { encodeBech32m } from './address.js'

export const FIXTURE_ORIGIN = 'http://127.0.0.1:9'
export const FIXTURE_API_KEY = 'cpay_sk_fixture_not_a_real_key'
// USD per ZEC. The 49TH-19 rate snapshot (2026-09-30T06:02:07Z); fixture only.
export const FIXTURE_ZEC_USD = 1406.86

export type CreateScenario =
  | 'ok'
  | 'fee_recipient'
  | 'timeout'
  | 'server_error_after_create'
  | 'malformed_response'
  | 'unauthorized'
  | 'amount_mismatch'
  | 'oversized_response'

export interface FixtureInvoice {
  id: string
  memo_code: string
  amount: number
  currency: string
  price_zec: number
  price_usd: number
  price_eur: number
  zec_rate_at_creation: number
  payment_address: string
  zcash_uri: string
  status: string
  detected_txid: string | null
  detected_at: string | null
  confirmed_at: string | null
  received_zatoshis: number
  price_zatoshis: number
  expires_at: string
  created_at: string
  // GET-only distortion for the amount_mismatch scenario.
  reported_price_zatoshis?: number
}

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'

// A u1 string that looks right but fails its Bech32m checksum.
export function unpayableAddress(): string {
  const data = [...randomBytes(120)].map((b) => b & 31)
  const valid = encodeBech32m('u', data)
  const last = valid.at(-1) as string
  const swapped = CHARSET[(CHARSET.indexOf(last) + 1) % 32]
  return valid.slice(0, -1) + swapped
}

function stamp(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z')
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function waitForAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return
    if (signal.aborted) reject(signal.reason)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

export interface FixtureCipherPayOptions {
  now?: () => number
  expiryMinutes?: number
  zecUsd?: number
}

export function createFixtureCipherPay(options: FixtureCipherPayOptions = {}) {
  const now = options.now ?? Date.now
  const expiryMinutes = options.expiryMinutes ?? 30
  const rate = options.zecUsd ?? FIXTURE_ZEC_USD
  const invoices = new Map<string, FixtureInvoice>()
  const scenarios: CreateScenario[] = []
  // A scenario bound to one call chain, so concurrent orders in a shared fixture server cannot take
  // each other's queued outcome.
  const scoped = new AsyncLocalStorage<CreateScenario>()
  const calls = { create: 0, get: 0 }

  function createInvoice(amount: number, currency: string, withFee: boolean): FixtureInvoice {
    const id = randomUUID()
    const memo = `CP-${randomBytes(4).toString('hex').toUpperCase()}`
    const priceZec = amount / rate
    const address = unpayableAddress()
    const zatoshis = Math.round(priceZec * 1e8)
    const uri = withFee
      ? `zcash:?address=${address}&amount=${priceZec.toFixed(8)}&memo=${b64(memo)}&address.1=${unpayableAddress()}&amount.1=${(priceZec * 0.01).toFixed(8)}&memo.1=${b64(`FEE-${id}`)}`
      : `zcash:${address}?amount=${priceZec.toFixed(8)}&memo=${b64(memo)}`
    const invoice: FixtureInvoice = {
      id,
      memo_code: memo,
      amount,
      currency,
      price_zec: priceZec,
      price_usd: amount,
      price_eur: amount * 0.92,
      zec_rate_at_creation: rate,
      payment_address: address,
      zcash_uri: uri,
      status: 'pending',
      detected_txid: null,
      detected_at: null,
      confirmed_at: null,
      received_zatoshis: 0,
      price_zatoshis: zatoshis,
      expires_at: stamp(now() + expiryMinutes * 60_000),
      created_at: stamp(now()),
    }
    invoices.set(id, invoice)
    return invoice
  }

  function createResponse(inv: FixtureInvoice) {
    // CreateInvoiceResponse: note the absence of any integer zatoshi field.
    return {
      invoice_id: inv.id,
      memo_code: inv.memo_code,
      amount: inv.amount,
      currency: inv.currency,
      price_eur: inv.price_eur,
      price_usd: inv.price_usd,
      price_zec: inv.price_zec,
      zec_rate: inv.zec_rate_at_creation,
      price_id: null,
      payment_address: inv.payment_address,
      zcash_uri: inv.zcash_uri,
      expires_at: inv.expires_at,
    }
  }

  function publicView(inv: FixtureInvoice) {
    return {
      id: inv.id,
      memo_code: inv.memo_code,
      product_name: 'Founding Agent Pass preorder',
      amount: inv.amount,
      currency: inv.currency,
      price_eur: inv.price_eur,
      price_usd: inv.price_usd,
      price_zec: inv.price_zec,
      zec_rate_at_creation: inv.zec_rate_at_creation,
      payment_address: inv.payment_address,
      zcash_uri: inv.zcash_uri,
      status: inv.status,
      detected_txid: inv.detected_txid,
      detected_at: inv.detected_at,
      confirmed_at: inv.confirmed_at,
      expires_at: inv.expires_at,
      created_at: inv.created_at,
      price_zatoshis: inv.reported_price_zatoshis ?? inv.price_zatoshis,
      received_zatoshis: inv.received_zatoshis,
      overpaid: inv.received_zatoshis > inv.price_zatoshis + 1000,
    }
  }

  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.origin !== FIXTURE_ORIGIN) throw new TypeError('fixture provider only answers its own origin')
    const method = (init.method ?? 'GET').toUpperCase()

    if (method === 'POST' && url.pathname === '/api/invoices') {
      calls.create++
      const scenario = scoped.getStore() ?? scenarios.shift() ?? 'ok'
      const auth = new Headers(init.headers).get('authorization')
      if (scenario === 'unauthorized' || auth !== `Bearer ${FIXTURE_API_KEY}`) return json({ error: 'Invalid API key' }, 401)
      const body = JSON.parse(String(init.body)) as { amount?: unknown; currency?: unknown }
      if (typeof body.amount !== 'number' || typeof body.currency !== 'string') return json({ error: 'bad request' }, 400)
      if (scenario === 'timeout') {
        createInvoice(body.amount, body.currency, false)
        return waitForAbort(init.signal)
      }
      const inv = createInvoice(body.amount, body.currency, scenario === 'fee_recipient')
      if (scenario === 'server_error_after_create') return json({ error: 'Failed to create invoice' }, 500)
      if (scenario === 'malformed_response') return json({ ...createResponse(inv), price_zec: String(inv.price_zec) }, 201)
      if (scenario === 'oversized_response') return json({ ...createResponse(inv), padding: 'x'.repeat(64 * 1024) }, 201)
      if (scenario === 'amount_mismatch') inv.reported_price_zatoshis = inv.price_zatoshis + 1
      return json(createResponse(inv), 201)
    }

    const match = /^\/api\/invoices\/([^/]+)$/.exec(url.pathname)
    if (method === 'GET' && match) {
      calls.get++
      const inv = invoices.get(match[1])
      return inv ? json(publicView(inv)) : json({ error: 'Invoice not found' }, 404)
    }
    return json({ error: 'not found' }, 404)
  }

  function get(id: string): FixtureInvoice {
    const inv = invoices.get(id)
    if (!inv) throw new Error(`fixture invoice ${id} not found`)
    return inv
  }

  return {
    fetch: fetchImpl as typeof fetch,
    calls,
    invoices,
    // Run `fn` with every create call inside it answering with `scenario`.
    withScenario<T>(scenario: CreateScenario, fn: () => Promise<T>): Promise<T> {
      return scoped.run(scenario, fn)
    },
    // Queue outcomes for the next create calls, in order. Default is `ok`.
    queueCreate(...next: CreateScenario[]) {
      scenarios.push(...next)
    },
    // Scanner behaviour from upstream (src/invoices/mod.rs): detected at >= 99.5% of price, underpaid
    // below. Detection stamps `detected_at` and moves `expires_at` to now + 30 minutes; underpayment
    // to now + 10 minutes. Payments to an expired invoice are still counted (a late payment) without
    // a status change. Timestamps use the fixture clock, so tests can pay before or after a deadline.
    pay(id: string, zatoshis: number, txid = randomBytes(32).toString('hex')) {
      const inv = get(id)
      inv.received_zatoshis += zatoshis
      inv.detected_txid = txid
      if (inv.status === 'pending' || inv.status === 'underpaid') {
        const full = inv.received_zatoshis * 1000 >= inv.price_zatoshis * 995
        inv.status = full ? 'detected' : 'underpaid'
        inv.detected_at = stamp(now())
        inv.expires_at = stamp(now() + (full ? 30 : 10) * 60_000)
      }
      return txid
    },
    // mark_confirmed: stamps `confirmed_at`, leaves `expires_at` alone.
    confirm(id: string) {
      const inv = get(id)
      if (inv.status === 'detected') {
        inv.status = 'confirmed'
        inv.confirmed_at = stamp(now())
      }
    },
    expire(id: string) {
      const inv = get(id)
      if (inv.status === 'pending' || inv.status === 'underpaid') inv.status = 'expired'
    },
    refund(id: string) {
      const inv = get(id)
      if (inv.status === 'confirmed') inv.status = 'refunded'
    },
    setStatus(id: string, status: string) {
      get(id).status = status
    },
    // Reports an existing txid on another invoice, as a provider bug or a replayed claim would.
    reportTxid(id: string, txid: string, zatoshis: number) {
      const inv = get(id)
      inv.detected_txid = txid
      inv.received_zatoshis = zatoshis
      inv.status = 'confirmed'
      inv.detected_at ??= stamp(now())
      inv.confirmed_at ??= stamp(now())
    },
  }
}

export type FixtureCipherPay = ReturnType<typeof createFixtureCipherPay>
