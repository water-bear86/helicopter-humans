// Independent review of 18b1728. Invented local fixtures only; the PG URL is
// supplied by Mika's disposable container. No merchant, wallet or payment.
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { runSandboxCommand } from './commands'
import { checkShieldedTransaction } from './harness'
import { probeDatabase, runPreflight } from './preflight'

const ENV = {
  SANDBOX_NETWORK: 'testnet', SANDBOX_CIPHERPAY_API_KEY: 'cpay_sk_independent_fixture_only',
  SANDBOX_DATABASE_URL: 'postgres://review:fixture@127.0.0.1/review_fixture',
  SANDBOX_DATABASE_IS_DISPOSABLE: 'yes',
}
const healthy = async () => new Response('{"status":"ok"}', { status: 200 })
const hex = (bytes: number) => 'ab'.repeat(bytes)
function validPolicyFixture() {
  return {
    txid: hex(32), authdigest: hex(32), size: 6000, locktime: 0, expiryheight: 3100000,
    version: 5, overwintered: true, versiongroupid: '26a7270a',
    vin: [], vout: [], vjoinsplit: [], vShieldedSpend: [], vShieldedOutput: [], valueBalance: 0, valueBalanceZat: 0,
    orchard: {
      actions: [{ cv: hex(32), nullifier: hex(32), rk: hex(32), cmx: hex(32), ephemeralKey: hex(32),
        encCiphertext: hex(580), outCiphertext: hex(80), spendAuthSig: hex(64) }],
      flags: { enableSpends: true, enableOutputs: true }, valueBalance: 0.0001, valueBalanceZat: 10000,
      anchor: hex(32), proof: hex(2720 + 2272), bindingSig: hex(64),
    },
  }
}

describe('independent retained success and finite health deadline', () => {
  it('retains the supported Orchard-only structural fixture and refuses a later schema', () => {
    expect(checkShieldedTransaction(validPolicyFixture()).fullyShielded).toBe(true)
    expect(checkShieldedTransaction({ ...validPolicyFixture(), version: 6 })).toMatchObject({ fullyShielded: false, verdict: 'unverified' })
  })

  it('cancels a chunked oversized health body', async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new TextEncoder().encode(pulls === 1 ? '{"status":"ok"}' + ' '.repeat(1009) : ' '.repeat(1024))) },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    const result = await runPreflight(ENV, { fetch: async () => new Response(body), probeDatabase: async () => ({ checkoutTables: true, testnetOnlyAddresses: true }) })
    expect(result.checks.find((c) => c.id === 'provider_testnet_health')?.status).toBe('fail')
    expect({ pulls, cancelled }).toEqual({ pulls: 5, cancelled: true })
  })

  it('aborts an actual stalled HTTP body at the five-second deadline', async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"status":'); })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    const start = Date.now()
    try {
      const result = await runPreflight(ENV, {
        fetch: (_url, options) => fetch(`http://127.0.0.1:${port}`, options),
        probeDatabase: async () => ({ checkoutTables: true, testnetOnlyAddresses: true }),
      })
      expect(result.checks.find((c) => c.id === 'provider_testnet_health')?.status).toBe('fail')
      expect(Date.now() - start).toBeGreaterThanOrEqual(4500)
      expect(Date.now() - start).toBeLessThan(6500)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 8000)
})

describe('independent incomplete and contradictory transaction probes', () => {
  it('does not certify nonzero Sapling ZEC balance with zero integer balance', () => {
    const result = checkShieldedTransaction({ ...validPolicyFixture(), valueBalance: 1 })
    console.log('contradictory Sapling balance result', result)
    expect(result.fullyShielded).toBe(false)
  })
  it('does not certify a nonzero Sapling balance when the integer balance is omitted', () => {
    const t = { ...validPolicyFixture(), valueBalance: 1, valueBalanceZat: undefined }
    const result = checkShieldedTransaction(t)
    console.log('missing Sapling integer balance result', result)
    expect(result.fullyShielded).toBe(false)
  })
  it('does not certify one-byte Orchard ciphertexts or signatures', () => {
    const t = validPolicyFixture()
    t.orchard.actions[0].encCiphertext = 'ab'
    t.orchard.actions[0].outCiphertext = 'ab'
    t.orchard.actions[0].spendAuthSig = 'ab'
    const result = checkShieldedTransaction(t)
    console.log('malformed Orchard widths result', result)
    expect(result.fullyShielded).toBe(false)
  })
  it('returns unverified for an incomplete nonempty Orchard bundle', () => {
    const t = validPolicyFixture()
    const incomplete = { ...t, orchard: { ...t.orchard, anchor: undefined, proof: undefined, bindingSig: undefined } }
    const result = checkShieldedTransaction(incomplete)
    console.log('incomplete Orchard bundle result', result)
    expect(result).toMatchObject({ fullyShielded: false, verdict: 'unverified' })
  })
})

describe('independent isolation before external access', () => {
  it.each([
    ['hosted', { VERCEL: '1' }],
    ['mainnet configured', { SANDBOX_NETWORK: 'mainnet' }],
    ['no disposable approval', { SANDBOX_DATABASE_IS_DISPOSABLE: undefined }],
    ['production URL', { CHECKOUT_DATABASE_URL: ENV.SANDBOX_DATABASE_URL }],
  ])('does not contact the provider or database after the %s guard refuses', async (_label, override) => {
    const health = vi.fn(healthy)
    const db = vi.fn(async () => ({ checkoutTables: true, testnetOnlyAddresses: true }))
    const makeDeps = vi.fn()
    const exit = await runSandboxCommand('refresh', [], {
      env: { ...ENV, ...override }, orderFile: '/nonexistent/order.json', out: () => {},
      preflight: (e) => runPreflight(e, { fetch: health, probeDatabase: db }), makeDeps,
    })
    console.log('refusal external calls', _label, { exit, health: health.mock.calls.length, database: db.mock.calls.length, makeDeps: makeDeps.mock.calls.length })
    expect(exit).toBe(1)
    expect({ health: health.mock.calls.length, database: db.mock.calls.length, makeDeps: makeDeps.mock.calls.length }).toEqual({ health: 0, database: 0, makeDeps: 0 })
  })
})

describe.skipIf(!process.env.CHECKOUT_PG_TEST_URL)('independent actual PostgreSQL schema isolation', () => {
  it('does not trust a production mainnet constraint renamed to the sandbox constraint', async () => {
    const admin = new pg.Client({ connectionString: process.env.CHECKOUT_PG_TEST_URL })
    const schema = `mika_review_${randomUUID().replaceAll('-', '')}`
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`)
      const migration = readFileSync(new URL('../../db/migrations/0001_checkout_orders.sql', import.meta.url), 'utf8')
      await admin.query(migration)
      await admin.query('ALTER TABLE checkout_invoices RENAME CONSTRAINT checkout_invoices_payment_address_check TO checkout_invoices_payment_address_testnet_only')
      const url = new URL(process.env.CHECKOUT_PG_TEST_URL!)
      url.searchParams.set('options', `-c search_path=${schema}`)
      const probe = await probeDatabase(url.toString())
      const constraints = await admin.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'checkout_invoices'::regclass AND conname = 'checkout_invoices_payment_address_testnet_only'")
      console.log('real mainnet constraint and probe', { definition: constraints.rows[0].definition, probe })
      expect(probe).toEqual({ checkoutTables: true, testnetOnlyAddresses: false })
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    }
  })
})
