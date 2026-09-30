// Independent follow-up probes for 077bf05. Invented documents and local fixtures only.
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { describe, it, expect, vi } from 'vitest'
import { runSandboxCommand } from './commands'
import { checkShieldedTransaction, SANDBOX_OFFER } from './harness'
import { probeDatabase, runPreflight } from './preflight'
import { createCheckoutService } from '../checkout/service'
import { MemoryOrderStore } from '../checkout/store'
import { createFixtureCipherPay, FIXTURE_ORIGIN, FIXTURE_API_KEY } from '../checkout/fixture-cipherpay'
import { createCipherPayClient } from '../checkout/cipherpay'
import { DRAFT_OFFER } from '../checkout/offer'
import { hashRecoveryCode } from '../checkout/credential'

const ENV = { SANDBOX_NETWORK: 'testnet', SANDBOX_CIPHERPAY_API_KEY: 'cpay_sk_fixture_only', SANDBOX_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1/fixture', SANDBOX_DATABASE_IS_DISPOSABLE: 'yes' }
const hex = (n: number) => 'ab'.repeat(n)
function supportedFixture() {
  return {
    txid: hex(32), version: 5, overwintered: true, versiongroupid: '26a7270a',
    vin: [], vout: [], vjoinsplit: [], vShieldedSpend: [], vShieldedOutput: [], valueBalance: 0, valueBalanceZat: 0,
    orchard: {
      actions: [{ cv: hex(32), nullifier: hex(32), rk: hex(32), cmx: hex(32), ephemeralKey: hex(32), encCiphertext: hex(580), outCiphertext: hex(80), spendAuthSig: hex(64) }],
      flags: { enableSpends: true, enableOutputs: true }, valueBalance: 0.0001, valueBalanceZat: 10000,
      anchor: hex(32), proof: hex(4992), bindingSig: hex(64),
    },
  }
}

describe('independent follow-up: exact coherent balance evidence', () => {
  it('retains supported success and legitimate omitted Sapling balances', () => {
    expect(checkShieldedTransaction(supportedFixture())).toMatchObject({ fullyShielded: true, verdict: 'orchard_only' })
    expect(checkShieldedTransaction({ ...supportedFixture(), valueBalance: undefined, valueBalanceZat: undefined })).toMatchObject({ fullyShielded: true, verdict: 'orchard_only' })
  })
  it.each([0.000000004, -0.000000004])('refuses nonzero Sapling ZEC %s with zero integer balance', (valueBalance) => {
    const result = checkShieldedTransaction({ ...supportedFixture(), valueBalance })
    console.log('fractional Sapling balance result', { valueBalance, result })
    expect(result).toMatchObject({ fullyShielded: false, verdict: 'fail' })
  })
  it('refuses nonzero sub-zatoshi Sapling ZEC when the integer balance is omitted', () => {
    const result = checkShieldedTransaction({ ...supportedFixture(), valueBalance: 0.000000004, valueBalanceZat: undefined })
    console.log('fractional Sapling ZEC without integer result', result)
    expect(result).toMatchObject({ fullyShielded: false, verdict: 'fail' })
  })
  it('refuses contradictory Orchard ZEC rather than rounding to the integer balance', () => {
    const t = supportedFixture()
    const result = checkShieldedTransaction({ ...t, orchard: { ...t.orchard, valueBalance: 0.000100004 } })
    console.log('fractional Orchard balance result', result)
    expect(result).toMatchObject({ fullyShielded: false, verdict: 'fail' })
  })
})

describe('independent follow-up: loaded order identity before provider reads', () => {
  it('refuses the actual non-sandbox order before even provider health, leaving its receipt unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mika-review-077bf05-'))
    const orderFile = join(dir, 'order.json')
    const store = new MemoryOrderStore()
    const fixture = createFixtureCipherPay()
    const provider = createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: fixture.fetch, allowLoopback: true })
    const svc = createCheckoutService({ store, provider, offer: DRAFT_OFFER })
    const { recoveryCode } = await svc.createOrder()
    await svc.ensureInvoice(recoveryCode)
    const inv = [...fixture.invoices.values()][0]
    fixture.pay(inv.id, inv.price_zatoshis)
    fixture.confirm(inv.id)
    await svc.refresh(recoveryCode)
    const before = await store.findByCredentialHash(hashRecoveryCode(recoveryCode))
    expect(before?.order.state).toBe('fulfilled')
    fixture.calls.get = 0
    writeFileSync(orderFile, JSON.stringify({ recoveryCode, network: 'testnet', offerVersion: SANDBOX_OFFER.version }), { mode: 0o600 })
    const events: string[] = []
    const find = store.findByCredentialHash.bind(store)
    vi.spyOn(store, 'findByCredentialHash').mockImplementation(async (key) => { events.push('loaded order identity'); return find(key) })
    const health = vi.fn(async () => { events.push('provider health'); return new Response('{"status":"ok"}') })
    try {
      const exit = await runSandboxCommand('refresh', [], {
        env: ENV, orderFile, out: () => {}, err: () => {},
        // Adapted for the staged preflight: the command's stages are passed on, as the default does.
        preflight: (env, stages) => runPreflight(env, { ...stages, fetch: health, probeDatabase: async () => { events.push('database schema'); return { checkoutTables: true, testnetOnlyAddresses: true } } }),
        makeDeps: () => ({ store, provider, orderFile }),
      })
      const after = await find(hashRecoveryCode(recoveryCode))
      console.log('mainnet identity refusal', { exit, events, healthReads: health.mock.calls.length, invoiceReads: fixture.calls.get, state: after?.order.state, receiptRevoked: Boolean(after?.receipt?.revokedAt) })
      expect(exit).toBe(1)
      expect(fixture.calls.get).toBe(0)
      expect(after).toEqual(before)
      expect(health).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!process.env.CHECKOUT_PG_TEST_URL)('independent follow-up: real schema binding', () => {
  it('refuses tables split across schemas and accepts the actual sandbox migration', async () => {
    const admin = new pg.Client({ connectionString: process.env.CHECKOUT_PG_TEST_URL })
    const schema = `mika_binding_${randomUUID().replaceAll('-', '')}`
    const other = `${schema}_other`
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schema}; CREATE SCHEMA ${other}; SET search_path TO ${schema}`)
      await admin.query(readFileSync(new URL('../../db/migrations/0001_checkout_orders.sql', import.meta.url), 'utf8'))
      await admin.query(readFileSync(new URL('../../db/sandbox/0001_testnet_only.sql', import.meta.url), 'utf8'))
      const url = new URL(process.env.CHECKOUT_PG_TEST_URL!)
      url.searchParams.set('options', `-c search_path=${schema},${other}`)
      expect(await probeDatabase(url.toString())).toEqual({ checkoutTables: true, testnetOnlyAddresses: true })
      await admin.query(`ALTER TABLE checkout_receipts SET SCHEMA ${other}`)
      const result = await probeDatabase(url.toString())
      console.log('real split schema result', result)
      expect(result.checkoutTables).toBe(false)
    } finally {
      await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP SCHEMA ${other} CASCADE`)
      await admin.end()
    }
  })
})
