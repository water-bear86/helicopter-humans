// Independent review probes for PR 4, SHA 519ac0d. All money, providers, keys and
// transactions here are invented local fixtures. No payment or remote database.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createCipherPayClient } from '../checkout/cipherpay'
import { createFixtureCipherPay, FIXTURE_API_KEY, FIXTURE_ORIGIN } from '../checkout/fixture-cipherpay'
import { DRAFT_OFFER } from '../checkout/offer'
import { createCheckoutService } from '../checkout/service'
import { hashRecoveryCode } from '../checkout/credential'
import { MemoryOrderStore } from '../checkout/store'
import { checkShieldedTransaction, refreshTestnetOrder, SANDBOX_OFFER } from './harness'
import { runPreflight } from './preflight'

describe('independent sandbox isolation and evidence probes', () => {
  it.each(['mainnet', 'testnet'])('refuses a mainnet order during refresh even if the file says %s', async (fileNetwork) => {
    const store = new MemoryOrderStore()
    const mainnet = createFixtureCipherPay()
    const mainClient = createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: mainnet.fetch, allowLoopback: true })
    const mainService = createCheckoutService({ store, provider: mainClient, offer: DRAFT_OFFER })
    const { recoveryCode } = await mainService.createOrder()
    await mainService.ensureInvoice(recoveryCode)
    const inv = [...mainnet.invoices.values()][0]
    mainnet.pay(inv.id, inv.price_zatoshis)
    mainnet.confirm(inv.id)
    expect((await mainService.refresh(recoveryCode)).state).toBe('fulfilled')

    const dir = mkdtempSync(join(tmpdir(), 'hh-review-sandbox-'))
    const orderFile = join(dir, 'order.json')
    writeFileSync(orderFile, JSON.stringify({ recoveryCode, network: fileNetwork, offerVersion: SANDBOX_OFFER.version }), { mode: 0o600 })
    const testnet = createFixtureCipherPay({ network: 'testnet' })
    const testClient = createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: testnet.fetch, allowLoopback: true, network: 'testnet' })
    let refused = false
    try { await refreshTestnetOrder({ store, provider: testClient, orderFile }) } catch { refused = true }
    const after = await store.findByCredentialHash(hashRecoveryCode(recoveryCode))
    expect({ refused, providerReads: testnet.calls.get, state: after?.order.state, receiptRevoked: Boolean(after?.receipt?.revokedAt) }).toEqual({
      refused: true, providerReads: 0, state: 'fulfilled', receiptRevoked: false,
    })
  })

  it('does not certify a Sapling-to-Orchard pool transfer as the required private single-pool spend', () => {
    const tx = {
      txid: 'ab'.repeat(32), version: 5, vin: [], vout: [], vjoinsplit: [],
      vShieldedSpend: [{}], vShieldedOutput: [], valueBalance: 1, valueBalanceZat: 100_000_000,
      orchard: { actions: [{}, {}], flags: { enableSpends: false, enableOutputs: true }, valueBalance: -0.9999, valueBalanceZat: -99_990_000 },
    }
    expect(checkShieldedTransaction(tx).fullyShielded).toBe(false)
  })

  it('refuses oversized provider-health data instead of reading the full body and then slicing it', async () => {
    let bytesRead = 0
    const payload = '{"status":"ok"}' + ' '.repeat(2 * 1024 * 1024)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const data = new TextEncoder().encode(payload)
        bytesRead += data.byteLength
        controller.enqueue(data)
        controller.close()
      },
    })
    const report = await runPreflight({
      SANDBOX_NETWORK: 'testnet', SANDBOX_CIPHERPAY_API_KEY: 'cpay_sk_review_fixture_only',
      SANDBOX_DATABASE_URL: 'postgres://review:fixture@127.0.0.1/review_fixture', SANDBOX_DATABASE_IS_DISPOSABLE: 'yes',
    }, {
      fetch: async () => new Response(body, { status: 200 }),
      probeDatabase: async () => ({ checkoutTables: true, testnetOnlyAddresses: true }),
    })
    expect(bytesRead).toBeGreaterThan(4096)
    expect(report.checks.find((c) => c.id === 'provider_testnet_health')?.status).toBe('fail')
  })
})
