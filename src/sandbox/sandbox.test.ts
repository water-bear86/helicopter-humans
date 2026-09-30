// The testnet sandbox harness and preflight, against the simulated provider in testnet mode. The
// PostgreSQL section needs CHECKOUT_PG_TEST_URL (a disposable server, see docs/CHECKOUT.md) and is
// reported as skipped without it.
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { encodeBech32, encodeBech32m, shieldedAddressKind } from '../checkout/address'
import { CIPHERPAY_ORIGIN, CIPHERPAY_TESTNET_ORIGIN, checkProviderOrigin, createCipherPayClient } from '../checkout/cipherpay'
import { createFixtureCipherPay, FIXTURE_API_KEY, FIXTURE_ORIGIN, unpayableAddress } from '../checkout/fixture-cipherpay'
import { hashRecoveryCode } from '../checkout/credential'
import { DRAFT_OFFER } from '../checkout/offer'
import { createCheckoutService } from '../checkout/service'
import { MemoryOrderStore, type OrderStore } from '../checkout/store'
import { PostgresOrderStore } from '../checkout/store-postgres'
import { runSandboxCommand } from './commands'
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

describe('provider health read is bounded', () => {
  const health = async (fetchImpl: typeof fetch) => statuses(await runPreflight(COMPLETE, { fetch: fetchImpl, probeDatabase: sandboxDb })).provider_testnet_health

  it('passes a small valid response', async () => {
    expect(await health(async () => new Response('{"status":"ok"}', { status: 200, headers: { 'content-length': '15' } }))).toBe('pass')
  })

  it('refuses a declared oversized length without reading the body', async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new TextEncoder().encode('{"status":"ok"}'))
        controller.close()
      },
      cancel() {
        cancelled = true
      },
    }, { highWaterMark: 0 })
    expect(await health(async () => new Response(body, { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } }))).toBe('fail')
    expect({ pulls, cancelled }).toEqual({ pulls: 0, cancelled: true })
  })

  it('stops a chunked stream at the limit and cancels it', async () => {
    let sent = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = new TextEncoder().encode(sent === 0 ? '{"status":"ok"}' + ' '.repeat(1009) : ' '.repeat(1024))
        sent += chunk.byteLength
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      },
    })
    expect(await health(async () => new Response(body, { status: 200 }))).toBe('fail')
    expect(cancelled).toBe(true)
    expect(sent).toBeLessThanOrEqual(8 * 1024)
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

// A confirmed mainnet preorder with a valid receipt, in the same store the sandbox would open.
async function mainnetFulfilledOrder(store: OrderStore) {
  const mainnet = createFixtureCipherPay()
  const svc = createCheckoutService({ store, provider: createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: mainnet.fetch, allowLoopback: true }), offer: DRAFT_OFFER })
  const { recoveryCode } = await svc.createOrder()
  await svc.ensureInvoice(recoveryCode)
  const inv = [...mainnet.invoices.values()][0]
  mainnet.pay(inv.id, inv.price_zatoshis)
  mainnet.confirm(inv.id)
  expect((await svc.refresh(recoveryCode)).state).toBe('fulfilled')
  return recoveryCode
}

async function unchanged(store: OrderStore, code: string) {
  const s = await store.findByCredentialHash(hashRecoveryCode(code))
  return { state: s?.order.state, receiptRevoked: Boolean(s?.receipt?.revokedAt) }
}

function writeOrderFile(file: string, content: Record<string, unknown>) {
  writeFileSync(file, JSON.stringify(content), { mode: 0o600 })
}

describe('sandbox isolation: refresh never touches a non-sandbox order', () => {
  const ready = (env: Record<string, string | undefined>) => runPreflight(env, { fetch: healthy, probeDatabase: sandboxDb })

  it.each([
    ['hosted runtime', { VERCEL: '1' }],
    ['production NODE_ENV', { NODE_ENV: 'production' }],
    ['mainnet network', { SANDBOX_NETWORK: 'mainnet' }],
    ['no disposable confirmation', { SANDBOX_DATABASE_IS_DISPOSABLE: undefined }],
    ['production database URL', { CHECKOUT_DATABASE_URL: DB }],
  ])('the CLI refuses refresh before opening any store: %s', async (_label, override) => {
    const makeDeps = vi.fn()
    const code = await runSandboxCommand('refresh', [], { env: { ...COMPLETE, ...override }, orderFile: '/nonexistent/order.json', preflight: ready, makeDeps, out: () => {} })
    expect(code).toBe(1)
    expect(makeDeps).not.toHaveBeenCalled()
  })

  it('the CLI refuses refresh against a database with the mainnet-only constraint', async () => {
    const makeDeps = vi.fn()
    const productionSchema = (env: Record<string, string | undefined>) => runPreflight(env, { fetch: healthy, probeDatabase: async () => ({ checkoutTables: true, testnetOnlyAddresses: false }) })
    expect(await runSandboxCommand('refresh', [], { env: COMPLETE, orderFile: '/nonexistent/order.json', preflight: productionSchema, makeDeps, out: () => {} })).toBe(1)
    expect(makeDeps).not.toHaveBeenCalled()
  })

  it.each(['mainnet', 'testnet'])('with a ready preflight, the CLI still refuses a mainnet order whose file says %s', async (label) => {
    const deps = fixtureDeps()
    const code = await mainnetFulfilledOrder(deps.store)
    writeOrderFile(deps.orderFile, { recoveryCode: code, network: label, offerVersion: SANDBOX_OFFER.version })
    const errors: string[] = []
    const exit = await runSandboxCommand('refresh', [], { env: COMPLETE, orderFile: deps.orderFile, preflight: ready, makeDeps: () => deps, out: () => {}, err: (l) => errors.push(l) })
    expect(exit).toBe(1)
    expect(errors.join('\n')).toMatch(/refused/)
    expect(errors.join('\n')).not.toContain(code)
    expect(deps.fixture.calls.get).toBe(0)
    expect(await unchanged(deps.store, code)).toEqual({ state: 'fulfilled', receiptRevoked: false })
  })

  it.each([
    ['network label', { network: 'mainnet' }],
    ['missing network', { network: undefined }],
    ['offer version', { offerVersion: DRAFT_OFFER.version }],
    ['recovery code', { recoveryCode: 42 }],
  ])('the helper refuses a sandbox order file with the wrong %s, with no provider read', async (_label, override) => {
    const deps = fixtureDeps()
    await createTestnetOrder(deps)
    const saved = JSON.parse(readFileSync(deps.orderFile, 'utf8'))
    const file = join(mkdtempSync(join(tmpdir(), 'hh-sandbox-')), 'order.json')
    writeOrderFile(file, { ...saved, ...override })
    const reads = deps.fixture.calls.get
    await expect(refreshTestnetOrder({ ...deps, orderFile: file })).rejects.toThrow(/order file/)
    expect(deps.fixture.calls.get).toBe(reads)
  })

  it('a genuine sandbox order still refreshes through the CLI', async () => {
    const deps = fixtureDeps()
    await createTestnetOrder(deps)
    const inv = [...deps.fixture.invoices.values()][0]
    deps.fixture.pay(inv.id, inv.price_zatoshis)
    deps.fixture.confirm(inv.id)
    const lines: string[] = []
    expect(await runSandboxCommand('refresh', [], { env: COMPLETE, orderFile: deps.orderFile, preflight: ready, makeDeps: () => deps, out: (l) => lines.push(l) })).toBe(0)
    expect(lines.join('\n')).toContain('"state": "fulfilled"')
  })
})

// Field names and shapes follow the zcashd verbose schema (getrawtransaction <txid> 1). Values are
// invented; this is not a real chain transaction.
function hex(bytes: number, seed: number) {
  return Array.from({ length: bytes }, (_, i) => ((seed * 31 + i * 7) % 256).toString(16).padStart(2, '0')).join('')
}
function orchardAction(seed: number) {
  return {
    cv: hex(32, seed), nullifier: hex(32, seed + 1), rk: hex(32, seed + 2), cmx: hex(32, seed + 3), ephemeralKey: hex(32, seed + 4),
    encCiphertext: hex(580, seed + 5), outCiphertext: hex(80, seed + 6), spendAuthSig: hex(64, seed + 7),
  }
}
function orchardOnlyTx() {
  return {
    txid: 'ab'.repeat(32), authdigest: 'cd'.repeat(32), size: 9165, overwintered: true, version: 5, versiongroupid: '26a7270a', locktime: 0, expiryheight: 3100000,
    vin: [], vout: [], vjoinsplit: [], valueBalance: 0, valueBalanceZat: 0, vShieldedSpend: [], vShieldedOutput: [],
    orchard: { actions: [orchardAction(1), orchardAction(2)], valueBalance: 0.0001, valueBalanceZat: 10_000, flags: { enableSpends: true, enableOutputs: true }, anchor: hex(32, 9), proof: hex(64, 10), bindingSig: hex(64, 11) },
  }
}
type Tx = ReturnType<typeof orchardOnlyTx>
const saplingSpend = { cv: hex(32, 20), anchor: hex(32, 21), nullifier: hex(32, 22), rk: hex(32, 23), proof: hex(192, 24), spendAuthSig: hex(64, 25) }
const saplingOutput = { cv: hex(32, 30), cmu: hex(32, 31), ephemeralKey: hex(32, 32), encCiphertext: hex(580, 33), outCiphertext: hex(80, 34), proof: hex(192, 35) }

describe('shielded transaction policy check (offline, Orchard only)', () => {
  it('passes a v5 Orchard-only spend whose Orchard balance is the fee', () => {
    expect(checkShieldedTransaction(orchardOnlyTx())).toEqual({ fullyShielded: true, verdict: 'orchard_only', orchardActions: 2, feeZatoshis: 10_000 })
  })

  const variants: [string, (t: Tx) => unknown, string][] = [
    ['Sapling to Orchard pool crossing', (t) => ({ ...t, vShieldedSpend: [saplingSpend], valueBalance: 1, valueBalanceZat: 100_000_000, orchard: { ...t.orchard, valueBalance: -0.9999, valueBalanceZat: -99_990_000, flags: { enableSpends: false, enableOutputs: true } } }), 'has Sapling spends (value crossing from Sapling)'],
    ['Orchard to Sapling pool crossing', (t) => ({ ...t, vShieldedOutput: [saplingOutput], valueBalanceZat: -50_000, orchard: { ...t.orchard, valueBalance: 0.0006, valueBalanceZat: 60_000 } }), 'has Sapling outputs (value crossing into Sapling)'],
    ['nonzero Sapling balance', (t) => ({ ...t, valueBalanceZat: 5 }), 'nonzero Sapling value balance'],
    ['Orchard spends disabled', (t) => ({ ...t, orchard: { ...t.orchard, flags: { enableSpends: false, enableOutputs: true } } }), 'Orchard spends disabled (value did not come from Orchard)'],
    ['Orchard flags missing', (t) => ({ ...t, orchard: { ...t.orchard, flags: undefined } }), 'Orchard flags missing'],
    ['negative Orchard balance', (t) => ({ ...t, orchard: { ...t.orchard, valueBalance: -0.0001, valueBalanceZat: -10_000 } }), 'Orchard value balance is not a positive fee'],
    ['Orchard balance missing', (t) => ({ ...t, orchard: { ...t.orchard, valueBalanceZat: undefined } }), 'Orchard valueBalanceZat missing'],
    ['disagreeing Orchard balances', (t) => ({ ...t, orchard: { ...t.orchard, valueBalance: 1 } }), 'Orchard valueBalance disagrees with valueBalanceZat'],
    ['transparent input', (t) => ({ ...t, vin: [{ txid: 'ef'.repeat(32), vout: 0 }] }), 'has transparent inputs'],
    ['transparent output', (t) => ({ ...t, vout: [{ valueZat: 1 }] }), 'has transparent outputs'],
    ['Sprout joinsplit', (t) => ({ ...t, vjoinsplit: [{}] }), 'has Sprout joinsplits'],
    ['vin missing', (t) => ({ ...t, vin: undefined }), 'vin missing'],
    ['Sapling spends missing', (t) => ({ ...t, vShieldedSpend: undefined }), 'vShieldedSpend missing'],
    ['malformed action', (t) => ({ ...t, orchard: { ...t.orchard, actions: [{}, {}] } }), 'Orchard action fields malformed'],
    ['no actions', (t) => ({ ...t, orchard: { ...t.orchard, actions: [] } }), 'no Orchard actions'],
    ['no Orchard bundle', (t) => ({ ...t, orchard: undefined }), 'no Orchard bundle'],
    ['bad txid', (t) => ({ ...t, txid: 'xyz' }), 'missing txid'],
    ['wrong version group', (t) => ({ ...t, versiongroupid: '892f2085' }), 'not a v5 (NU5) transaction encoding'],
    ['v4 transaction', (t) => ({ ...t, version: 4 }), 'not a v5 transaction (no Orchard)'],
    ['version missing', (t) => ({ ...t, version: undefined }), 'version missing'],
  ]
  it.each(variants)('fails: %s', (_label, change, reason) => {
    const result = checkShieldedTransaction(change(orchardOnlyTx()))
    expect(result).toMatchObject({ fullyShielded: false, verdict: 'fail' })
    expect(!result.fullyShielded && result.reasons).toContain(reason)
  })

  it('reports an unknown later transaction version as unverified, not passed', () => {
    expect(checkShieldedTransaction({ ...orchardOnlyTx(), version: 6 })).toMatchObject({ fullyShielded: false, verdict: 'unverified' })
  })

  it.each([null, [], 'tx', 5])('fails a non-object %j', (tx) => {
    expect(checkShieldedTransaction(tx)).toMatchObject({ fullyShielded: false, verdict: 'fail' })
  })

  it('check-tx exits 1 on malformed JSON and 0 on the Orchard-only fixture', async () => {
    expect(await runSandboxCommand('check-tx', [], { env: {}, orderFile: '', readStdin: () => '{not json', out: () => {} })).toBe(1)
    expect(await runSandboxCommand('check-tx', [], { env: {}, orderFile: '', readStdin: () => JSON.stringify(orchardOnlyTx()), out: () => {} })).toBe(0)
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

  it('the CLI refuses refresh against a production-shaped database, using the real probe', async () => {
    const other = `sandbox_prod_${randomUUID().replaceAll('-', '')}`
    const admin = new pg.Client({ connectionString: PG_URL })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${other}; SET search_path TO ${other}`)
    await admin.query(`BEGIN; ${read('../../db/migrations/0001_checkout_orders.sql')}; COMMIT;`)
    try {
      const url = new URL(PG_URL!)
      url.searchParams.set('options', `-c search_path=${other}`)
      const env = { ...COMPLETE, SANDBOX_DATABASE_URL: url.toString() }
      const makeDeps = vi.fn()
      const exit = await runSandboxCommand('refresh', [], { env, orderFile: '/nonexistent/order.json', preflight: (e) => runPreflight(e, { fetch: healthy }), makeDeps, out: () => {} })
      expect(exit).toBe(1)
      expect(makeDeps).not.toHaveBeenCalled()
    } finally {
      await admin.query(`DROP SCHEMA ${other} CASCADE`)
      await admin.end()
    }
  })

  it('the helper refuses a non-sandbox order in the durable sandbox store, leaving it unchanged', async () => {
    const pool = new pg.Pool({ connectionString: scoped(), max: 3 })
    pools.push(pool)
    const deps = fixtureDeps(new PostgresOrderStore({ pool }))
    const { recoveryCode } = await createCheckoutService({ store: deps.store, provider: deps.provider, offer: DRAFT_OFFER }).createOrder()
    writeOrderFile(deps.orderFile, { recoveryCode, network: 'testnet', offerVersion: SANDBOX_OFFER.version })
    const before = await deps.store.findByCredentialHash(hashRecoveryCode(recoveryCode))
    await expect(refreshTestnetOrder(deps)).rejects.toThrow(/not a sandbox testnet order/)
    expect(deps.fixture.calls.get).toBe(0)
    expect(await deps.store.findByCredentialHash(hashRecoveryCode(recoveryCode))).toEqual(before)
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
