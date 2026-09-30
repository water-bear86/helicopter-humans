// The testnet sandbox harness and preflight, against the simulated provider in testnet mode. The
// PostgreSQL section needs CHECKOUT_PG_TEST_URL (a disposable server, see docs/CHECKOUT.md) and is
// reported as skipped without it.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeBech32, encodeBech32m, shieldedAddressKind } from '../checkout/address'
import { CIPHERPAY_ORIGIN, CIPHERPAY_TESTNET_ORIGIN, checkProviderOrigin, createCipherPayClient } from '../checkout/cipherpay'
import { createFixtureCipherPay, FIXTURE_API_KEY, FIXTURE_ORIGIN, unpayableAddress } from '../checkout/fixture-cipherpay'
import { createCheckoutService } from '../checkout/service'
import { MemoryOrderStore } from '../checkout/store'
import { PostgresOrderStore } from '../checkout/store-postgres'
import { checkShieldedTransaction, createTestnetOrder, refreshTestnetOrder, SANDBOX_OFFER, type HarnessDeps } from './harness'
import { probeDatabase, runPreflight } from './preflight'

const KEY = 'cpay_sk_sandbox_fixture_value_1234'
const DB = 'postgres://sandbox:pw-secret@db.sandbox.example/hh_sandbox?sslmode=require'
const COMPLETE = { SANDBOX_NETWORK: 'testnet', SANDBOX_CIPHERPAY_API_KEY: KEY, SANDBOX_DATABASE_URL: DB, SANDBOX_DATABASE_IS_DISPOSABLE: 'yes' }
const healthy = vi.fn(async () => new Response('{"service":"cipherpay","status":"ok"}', { status: 200 }))
const sandboxDb = vi.fn(async () => ({ checkoutTables: true, testnetOnlyAddresses: true }))

function statuses(report: Awaited<ReturnType<typeof runPreflight>>) {
  return Object.fromEntries(report.checks.map((c) => [c.id, c.status]))
}

describe('sandbox preflight', () => {
  it('is ready only when every check passes, and never prints a value', async () => {
    const report = await runPreflight(COMPLETE, { fetch: healthy, probeDatabase: sandboxDb })
    expect(report.ready).toBe(true)
    expect(report.providerOrigin).toBe('https://api.testnet.cipherpay.app')
    expect(healthy).toHaveBeenCalledWith('https://api.testnet.cipherpay.app/api/health', expect.objectContaining({ redirect: 'error' }))
    const text = JSON.stringify(report)
    for (const secret of [KEY, 'pw-secret', 'db.sandbox.example', 'hh_sandbox']) expect(text).not.toContain(secret)
  })

  it('fails closed and names each missing variable when nothing is configured', async () => {
    const report = await runPreflight({}, { fetch: healthy, probeDatabase: sandboxDb })
    expect(report.ready).toBe(false)
    expect(statuses(report)).toMatchObject({ network_testnet: 'missing', api_key: 'missing', database_url: 'missing', database_disposable: 'missing', database_schema: 'skipped' })
    expect(sandboxDb).not.toHaveBeenCalled()
  })

  it.each([
    [{ VERCEL: '1' }, 'runtime_local'],
    [{ NODE_ENV: 'production' }, 'runtime_local'],
    [{ SANDBOX_NETWORK: 'mainnet' }, 'network_testnet'],
    [{ SANDBOX_CIPHERPAY_API_KEY: 'not-a-key' }, 'api_key'],
    [{ CIPHERPAY_API_KEY: KEY }, 'api_key'],
    [{ CHECKOUT_DATABASE_URL: DB }, 'database_url'],
    [{ SANDBOX_DATABASE_URL: 'postgres://u:p@db.example.com/x' }, 'database_url'],
    [{ SANDBOX_DATABASE_IS_DISPOSABLE: 'true' }, 'database_disposable'],
  ])('refuses %j (%s)', async (override, id) => {
    const report = await runPreflight({ ...COMPLETE, ...override }, { fetch: healthy, probeDatabase: sandboxDb })
    expect(report.ready).toBe(false)
    expect(statuses(report)[id]).toBe('fail')
  })

  it('refuses an unhealthy provider, a production-shaped database, and an offline run', async () => {
    const down = vi.fn(async () => new Response('bad gateway', { status: 502 }))
    expect(statuses(await runPreflight(COMPLETE, { fetch: down, probeDatabase: sandboxDb })).provider_testnet_health).toBe('fail')
    const mainnetDb = vi.fn(async () => ({ checkoutTables: true, testnetOnlyAddresses: false }))
    expect(statuses(await runPreflight(COMPLETE, { fetch: healthy, probeDatabase: mainnetDb })).database_schema).toBe('fail')
    const unreachable = vi.fn(async () => Promise.reject(new Error(`connect ECONNREFUSED ${DB}`)))
    const report = await runPreflight(COMPLETE, { fetch: healthy, probeDatabase: unreachable })
    expect(statuses(report).database_schema).toBe('fail')
    expect(JSON.stringify(report)).not.toContain('pw-secret')
    const offline = await runPreflight(COMPLETE, { offline: true })
    expect(offline.ready).toBe(false)
    expect(statuses(offline)).toMatchObject({ provider_testnet_health: 'skipped', database_schema: 'skipped' })
  })
})

describe('testnet network support', () => {
  it('pins each network to its own origin with no fallback', () => {
    expect(checkProviderOrigin(CIPHERPAY_TESTNET_ORIGIN, false, 'testnet')).toBe(CIPHERPAY_TESTNET_ORIGIN)
    expect(() => checkProviderOrigin(CIPHERPAY_ORIGIN, false, 'testnet')).toThrow()
    expect(() => checkProviderOrigin(CIPHERPAY_TESTNET_ORIGIN)).toThrow()
    expect(() => checkProviderOrigin('https://testnet.api.cipherpay.app', false, 'testnet')).toThrow()
    expect(() => checkProviderOrigin('https://user@api.testnet.cipherpay.app', false, 'testnet')).toThrow()
  })

  it('validates refund addresses for the order network only', () => {
    const utest = encodeBech32m('utest', Array.from({ length: 120 }, (_, i) => (i * 5) % 32))
    const ztest = encodeBech32('ztestsapling', Array.from({ length: 69 }, (_, i) => (i * 3) % 32))
    const u1 = encodeBech32m('u', Array.from({ length: 120 }, (_, i) => (i * 7) % 32))
    expect(shieldedAddressKind(utest, 'testnet')).toBe('unified')
    expect(shieldedAddressKind(ztest, 'testnet')).toBe('sapling')
    expect(shieldedAddressKind(u1, 'testnet')).toBeUndefined()
    expect(shieldedAddressKind(utest)).toBeUndefined()
    expect(shieldedAddressKind(ztest)).toBeUndefined()
  })
})

function fixtureDeps(store: HarnessDeps['store'] = new MemoryOrderStore()): HarnessDeps & { fixture: ReturnType<typeof createFixtureCipherPay> } {
  const fixture = createFixtureCipherPay({ network: 'testnet' })
  const provider = createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: fixture.fetch, allowLoopback: true, network: 'testnet', timeoutMs: 500 })
  return { store, provider, fixture, orderFile: join(mkdtempSync(join(tmpdir(), 'hh-sandbox-')), 'order.json') }
}

describe('testnet harness through the accepted order service', () => {
  it('creates one testnet invoice, keeps the recovery code in a 0600 file, and refuses a second attempt', async () => {
    const deps = fixtureDeps()
    const { evidence, uri } = await createTestnetOrder(deps)
    expect(evidence.state).toBe('awaiting_payment')
    expect(evidence.offer).toEqual({ id: SANDBOX_OFFER.id, version: SANDBOX_OFFER.version })
    expect(evidence.payment?.address).toMatch(/^utest1/)
    expect(uri).toMatch(/^zcash:utest1/)
    expect(statSync(deps.orderFile).mode & 0o777).toBe(0o600)
    const code = JSON.parse(readFileSync(deps.orderFile, 'utf8')).recoveryCode
    expect(JSON.stringify(evidence)).not.toContain(code)
    await expect(createTestnetOrder(deps)).rejects.toThrow(/one attempt per file/)
    expect(deps.fixture.calls.create).toBe(1)
  })

  it('records a confirmed full payment once, from a provider read', async () => {
    const deps = fixtureDeps()
    await createTestnetOrder(deps)
    const inv = [...deps.fixture.invoices.values()][0]
    deps.fixture.pay(inv.id, inv.price_zatoshis)
    deps.fixture.confirm(inv.id)
    const after = await refreshTestnetOrder(deps)
    expect(after.state).toBe('fulfilled')
    expect(after.receipt?.revoked).toBe(false)
    expect(after.payment).toBeNull()
  })

  it('a testnet client refuses a mainnet invoice address rather than showing it', async () => {
    const fixture = createFixtureCipherPay({ network: 'mainnet' })
    const provider = createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: fixture.fetch, allowLoopback: true, network: 'testnet', timeoutMs: 500 })
    const svc = createCheckoutService({ store: new MemoryOrderStore(), provider, offer: SANDBOX_OFFER, network: 'testnet' })
    const { recoveryCode } = await svc.createOrder()
    const view = await svc.ensureInvoice(recoveryCode)
    expect(view.payment).toBeNull()
    expect(view.state).toBe('reconciliation_required')
    expect(unpayableAddress('testnet')).toMatch(/^utest1/)
  })

  it('refund addresses on a testnet order must be testnet addresses', async () => {
    const deps = fixtureDeps()
    await createTestnetOrder(deps)
    const code = JSON.parse(readFileSync(deps.orderFile, 'utf8')).recoveryCode
    const inv = [...deps.fixture.invoices.values()][0]
    deps.fixture.pay(inv.id, inv.price_zatoshis)
    deps.fixture.confirm(inv.id)
    const svc = createCheckoutService({ store: deps.store, provider: deps.provider, offer: SANDBOX_OFFER, network: 'testnet' })
    await svc.refresh(code)
    const u1 = encodeBech32m('u', Array.from({ length: 120 }, (_, i) => (i * 7) % 32))
    await expect(svc.requestRefund(code, u1)).rejects.toMatchObject({ code: 'invalid_refund_address' })
    const utest = encodeBech32m('utest', Array.from({ length: 120 }, (_, i) => (i * 5) % 32))
    expect((await svc.requestRefund(code, utest)).state).toBe('needs_resolution')
  })
})

describe('fully shielded transaction check', () => {
  const txid = 'ab'.repeat(32)
  it('accepts an Orchard-only transaction with no transparent parts', () => {
    expect(checkShieldedTransaction({ txid, vin: [], vout: [], vjoinsplit: [], vShieldedSpend: [], vShieldedOutput: [], orchard: { actions: [{}, {}] } })).toEqual({
      fullyShielded: true,
      orchardActions: 2,
      saplingSpends: 0,
      saplingOutputs: 0,
    })
  })

  it.each([
    [{ txid, vin: [{}], vout: [], orchard: { actions: [{}] } }, 'has transparent inputs'],
    [{ txid, vin: [], vout: [{}], orchard: { actions: [{}] } }, 'has transparent outputs'],
    [{ txid, vout: [], orchard: { actions: [{}] } }, 'vin missing'],
    [{ txid, vin: [], vout: [], vjoinsplit: [{}], orchard: { actions: [{}] } }, 'has Sprout joinsplits'],
    [{ txid, vin: [], vout: [], vShieldedOutput: [{}] }, 'no Orchard actions (CipherPay detects Orchard payments)'],
    [{ vin: [], vout: [], orchard: { actions: [{}] } }, 'missing txid'],
  ])('rejects %j', (tx, reason) => {
    const result = checkShieldedTransaction(tx)
    expect(result.fullyShielded).toBe(false)
    expect(!result.fullyShielded && result.reasons).toContain(reason)
  })
})

const PG_URL = process.env.CHECKOUT_PG_TEST_URL
describe.skipIf(!PG_URL)('sandbox database (PostgreSQL)', () => {
  const schema = `sandbox_test_${randomUUID().replaceAll('-', '')}`
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const scoped = () => {
    const url = new URL(PG_URL!)
    url.searchParams.set('options', `-c search_path=${schema}`)
    return url.toString()
  }
  const pools: pg.Pool[] = []

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: PG_URL })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`)
    await admin.query(`BEGIN; ${read('../../db/migrations/0001_checkout_orders.sql')}; COMMIT;`)
    await admin.end()
  })
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()))
    const admin = new pg.Client({ connectionString: PG_URL })
    await admin.connect()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })

  it('the probe tells a production-shaped schema from a sandbox one, read-only', async () => {
    expect(await probeDatabase(scoped())).toEqual({ checkoutTables: true, testnetOnlyAddresses: false })
    const admin = new pg.Client({ connectionString: scoped() })
    await admin.connect()
    await admin.query(`BEGIN; ${read('../../db/sandbox/0001_testnet_only.sql')}; COMMIT;`)
    await admin.end()
    expect(await probeDatabase(scoped())).toEqual({ checkoutTables: true, testnetOnlyAddresses: true })
  })

  it('runs the harness against the durable store, and the sandbox schema refuses a mainnet invoice address', async () => {
    const pool = new pg.Pool({ connectionString: scoped(), max: 3 })
    pools.push(pool)
    const deps = fixtureDeps(new PostgresOrderStore({ pool }))
    const { evidence } = await createTestnetOrder(deps)
    expect(evidence.state).toBe('awaiting_payment')
    const inv = [...deps.fixture.invoices.values()][0]
    deps.fixture.pay(inv.id, inv.price_zatoshis)
    deps.fixture.confirm(inv.id)
    expect((await refreshTestnetOrder(deps)).state).toBe('fulfilled')
    const rows = await pool.query('SELECT count(*)::int AS n FROM checkout_receipts')
    expect(rows.rows[0].n).toBe(1)
    await expect(
      pool.query(
        `INSERT INTO checkout_invoices (provider_invoice_id, order_id, memo_code, payment_address, price_zec, quote_expires_at, provider_expires_at, provider_status, created_at, updated_at)
         SELECT $1, id, 'CP-00000000', $2, 0.001, now(), now(), 'pending', now(), now() FROM checkout_orders LIMIT 1`,
        [randomUUID(), unpayableAddress('mainnet')],
      ),
    ).rejects.toThrow(/checkout_invoices_payment_address_testnet_only/)
  })
})
