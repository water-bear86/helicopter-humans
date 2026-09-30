// Shared scenarios for the order service, run against every OrderStore (memory in service.test.ts,
// PostgreSQL in store-postgres.test.ts). Not a test file itself.
import { describe, expect, it } from 'vitest'
import { encodeBech32, encodeBech32m } from './address.js'
import { createCipherPayClient, type InvoiceProvider } from './cipherpay.js'
import { hashRecoveryCode } from './credential.js'
import { createFixtureCipherPay, FIXTURE_API_KEY, FIXTURE_ORIGIN, type FixtureCipherPay } from './fixture-cipherpay.js'
import { DRAFT_OFFER } from './offer.js'
import { CheckoutError, createCheckoutService, type CheckoutService } from './service.js'
import { StoreUnavailableError, type OrderStore } from './store.js'

export const START = Date.parse('2026-10-01T00:00:00Z')

export interface Harness {
  clock: { t: number }
  provider: FixtureCipherPay
  client: InvoiceProvider
  store: OrderStore
  service: CheckoutService
  // A second service instance over the same store and provider, as another function instance would be.
  other: CheckoutService
}

export function harness(store: OrderStore, opts: { claimTtlMs?: number; wrapStore?: (s: OrderStore) => OrderStore } = {}): Harness {
  const clock = { t: START }
  const now = () => clock.t
  const provider = createFixtureCipherPay({ now })
  const client = createCipherPayClient({ origin: FIXTURE_ORIGIN, apiKey: FIXTURE_API_KEY, fetch: provider.fetch, allowLoopback: true, timeoutMs: 200 })
  const used = opts.wrapStore ? opts.wrapStore(store) : store
  const make = () => createCheckoutService({ store: used, provider: client, offer: DRAFT_OFFER, now, claimTtlMs: opts.claimTtlMs ?? 30_000 })
  return { clock, provider, client, store: used, service: make(), other: make() }
}

export function validUnifiedAddress(): string {
  return encodeBech32m('u', Array.from({ length: 120 }, (_, i) => (i * 7) % 32))
}

export function validSaplingAddress(): string {
  return encodeBech32('zs', Array.from({ length: 69 }, (_, i) => (i * 3) % 32))
}

export async function paidOrder(h: Harness) {
  const { recoveryCode } = await h.service.createOrder()
  const view = await h.service.ensureInvoice(recoveryCode)
  const invoiceId = activeInvoiceId(h, view.payment!.address)
  return { code: recoveryCode, view, invoiceId }
}

export function activeInvoiceId(h: Harness, address: string): string {
  for (const inv of h.provider.invoices.values()) if (inv.payment_address === address) return inv.id
  throw new Error('no invoice for address')
}

function lastInvoice(h: Harness) {
  return [...h.provider.invoices.values()].at(-1)!
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toSatisfy((e: unknown) => e instanceof CheckoutError && e.code === code)
}

export function serviceContract(name: string, makeStore: () => Promise<OrderStore> | OrderStore) {
  describe(`${name}: checkout service contract`, () => {
    it('makes an invoice payable only after the GET supplies the integer amount, and grants once on confirmation', async () => {
      const h = harness(await makeStore())
      const { recoveryCode, order } = await h.service.createOrder()
      expect(order.state).toBe('new')
      expect(order.payment).toBeNull()
      const view = await h.service.ensureInvoice(recoveryCode)
      const inv = lastInvoice(h)
      expect(view.state).toBe('awaiting_payment')
      expect(view.payment).toMatchObject({ amountZatoshis: inv.price_zatoshis, address: inv.payment_address, reference: inv.memo_code })
      expect(view.payment!.amountZec).toBe((inv.price_zatoshis / 1e8).toFixed(8).replace(/0+$/, ''))
      expect(view.payment!.uri).toBe(`zcash:${inv.payment_address}?amount=${view.payment!.amountZec}&memo=${Buffer.from(inv.memo_code).toString('base64url')}`)
      expect(view.offer).toMatchObject({ version: DRAFT_OFFER.version, approved: false })
      expect(h.provider.calls).toEqual({ create: 1, get: 1 })

      h.provider.pay(inv.id, inv.price_zatoshis)
      let after = await h.service.refresh(recoveryCode)
      expect(after.state).toBe('payment_detected')
      expect(after.payment).toBeNull()
      expect(after.receipt).toBeNull()

      h.provider.confirm(inv.id)
      after = await h.service.refresh(recoveryCode)
      expect(after.state).toBe('fulfilled')
      expect(after.receipt).toMatchObject({ revoked: false })
      const again = await h.other.refresh(recoveryCode)
      expect(again.receipt!.id).toBe(after.receipt!.id)
    })

    it('ordinary retries return the existing invoice; concurrent retries create exactly one', async () => {
      const h = harness(await makeStore())
      const { recoveryCode } = await h.service.createOrder()
      const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => (i % 2 ? h.service : h.other).ensureInvoice(recoveryCode)))
      expect(h.provider.calls.create).toBe(1)
      for (const r of results) {
        if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'invoice_creation_in_progress' })
      }
      const addresses = new Set(results.flatMap((r) => (r.status === 'fulfilled' && r.value.payment ? [r.value.payment.address] : [])))
      expect(addresses.size).toBe(1)
      const retry = await h.service.ensureInvoice(recoveryCode)
      expect(retry.payment!.address).toBe([...addresses][0])
      expect(h.provider.calls.create).toBe(1)
    })

    it('concurrent refreshes after confirmation write exactly one receipt', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      h.provider.pay(invoiceId, h.provider.invoices.get(invoiceId)!.price_zatoshis)
      h.provider.confirm(invoiceId)
      const views = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? h.service : h.other).refresh(code)))
      const ids = new Set(views.map((v) => v.receipt?.id))
      expect(ids.size).toBe(1)
      expect([...ids][0]).toBeTruthy()
    })

    it('two buyers are isolated: neither code reaches the other order', async () => {
      const h = harness(await makeStore())
      const a = await paidOrder(h)
      const b = await h.service.createOrder()
      const bView = await h.service.getOrder(b.recoveryCode)
      expect(bView.payment).toBeNull()
      h.provider.pay(a.invoiceId, h.provider.invoices.get(a.invoiceId)!.price_zatoshis)
      h.provider.confirm(a.invoiceId)
      expect((await h.service.refresh(b.recoveryCode)).receipt).toBeNull()
      await expectCode(h.service.requestRefund(b.recoveryCode, validUnifiedAddress()), 'nothing_to_refund')
      expect((await h.service.refresh(a.code)).state).toBe('fulfilled')
      // A code that was never issued, or a public identifier used as a code, finds nothing.
      await expectCode(h.service.getOrder(`hhr_${'A'.repeat(43)}`), 'order_not_found')
      await expectCode(h.service.getOrder(a.invoiceId), 'order_not_found')
    })

    it('a provider timeout on create becomes reconciliation, never a second invoice', async () => {
      const h = harness(await makeStore())
      const { recoveryCode } = await h.service.createOrder()
      h.provider.queueCreate('timeout')
      const view = await h.service.ensureInvoice(recoveryCode)
      expect(view.state).toBe('reconciliation_required')
      expect(view.notice).toBe('invoice_creation_outcome_unknown')
      expect(view.payment).toBeNull()
      expect((await h.service.ensureInvoice(recoveryCode)).state).toBe('reconciliation_required')
      await expectCode(h.service.ensureInvoice(recoveryCode, { newQuote: true }), 'action_not_allowed')
      expect(h.provider.calls.create).toBe(1)
    })

    it.each(['server_error_after_create', 'malformed_response', 'oversized_response'] as const)('an ambiguous create (%s) is not payable and not retried', async (scenario) => {
      const h = harness(await makeStore())
      const { recoveryCode } = await h.service.createOrder()
      h.provider.queueCreate(scenario)
      const view = await h.service.ensureInvoice(recoveryCode)
      expect(view.state).toBe('reconciliation_required')
      expect(view.payment).toBeNull()
      await h.service.ensureInvoice(recoveryCode)
      expect(h.provider.calls.create).toBe(1)
    })

    it('a definite provider refusal (401) returns the order to new so a retry is safe', async () => {
      const h = harness(await makeStore())
      const { recoveryCode } = await h.service.createOrder()
      h.provider.queueCreate('unauthorized')
      const view = await h.service.ensureInvoice(recoveryCode)
      expect(view).toMatchObject({ state: 'new', notice: 'provider_rejected', stateReason: 'provider_rejected_http_401' })
      expect((await h.service.ensureInvoice(recoveryCode)).state).toBe('awaiting_payment')
      expect(h.provider.calls.create).toBe(2)
    })

    it('a claim abandoned mid-creation (crash) becomes reconciliation after its TTL', async () => {
      const h = harness(await makeStore(), { claimTtlMs: 5_000 })
      // The holder took the claim and died: nothing was ever bound.
      const { recoveryCode: second } = await h.service.createOrder()
      const store = h.store
      const snap = await store.findByCredentialHash(hashRecoveryCode(second))
      await store.update(snap!.order.id, () => ({
        changes: { order: { state: 'creating_invoice', claimToken: crypto.randomUUID(), claimExpiresAt: new Date(h.clock.t + 5_000).toISOString(), quoteCount: 1 } },
        result: undefined,
      }))
      await expectCode(h.service.ensureInvoice(second), 'invoice_creation_in_progress')
      h.clock.t += 6_000
      const view = await h.service.refresh(second)
      expect(view).toMatchObject({ state: 'reconciliation_required', stateReason: 'invoice_creation_outcome_unknown', payment: null })
    })

    it('rejects an extra fee recipient before any payment detail is shown, and does not strip it', async () => {
      const h = harness(await makeStore())
      const { recoveryCode } = await h.service.createOrder()
      h.provider.queueCreate('fee_recipient')
      const view = await h.service.ensureInvoice(recoveryCode)
      expect(view).toMatchObject({ state: 'quote_rejected', stateReason: 'payment_uri_unapproved_fee_recipient', payment: null })
      expect(JSON.stringify(view)).not.toContain(lastInvoice(h).payment_address)
      expect(view.actions.newQuote).toBe(true)
      h.provider.queueCreate('fee_recipient')
      expect((await h.service.ensureInvoice(recoveryCode, { newQuote: true })).state).toBe('quote_rejected')
      expect((await h.service.ensureInvoice(recoveryCode, { newQuote: true })).state).toBe('awaiting_payment')
      await expectCode(h.service.ensureInvoice(recoveryCode, { newQuote: true }), 'action_not_allowed')
    })

    it('rejects a GET whose integer amount disagrees with the created price', async () => {
      const h = harness(await makeStore())
      const { recoveryCode } = await h.service.createOrder()
      h.provider.queueCreate('amount_mismatch')
      const view = await h.service.ensureInvoice(recoveryCode)
      expect(view).toMatchObject({ state: 'quote_rejected', stateReason: 'price_zatoshis_inconsistent', payment: null })
    })

    it('an underpayment is not granted, hides the address and allows a refund request, never a second payment prompt', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      h.provider.pay(invoiceId, 1000)
      const view = await h.service.refresh(code)
      expect(view).toMatchObject({ state: 'needs_resolution', stateReason: 'underpaid', payment: null, receipt: null })
      expect(view.received).toMatchObject({ receivedZec: '0.00001' })
      expect(view.actions).toMatchObject({ requestRefund: true, newQuote: false, cancel: false })
      await expectCode(h.service.requestRefund(code, 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU'), 'invalid_refund_address')
      const refunded = await h.service.requestRefund(code, validUnifiedAddress())
      expect(refunded.refundRequest!.address).toContain('…')
      await expectCode(h.service.requestRefund(code, validSaplingAddress()), 'refund_already_requested')
    })

    it('a multi-payment invoice is granted once confirmed in full; each txid is claimed without quarantine', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      const price = h.provider.invoices.get(invoiceId)!.price_zatoshis
      h.provider.pay(invoiceId, Math.floor(price / 2))
      h.provider.pay(invoiceId, price - Math.floor(price / 2))
      expect((await h.service.refresh(code)).state).toBe('payment_detected')
      h.provider.confirm(invoiceId)
      expect((await h.service.refresh(code)).state).toBe('fulfilled')
    })

    it('a partial payment seen first stays for review even if the provider later confirms the total', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      const price = h.provider.invoices.get(invoiceId)!.price_zatoshis
      h.provider.pay(invoiceId, Math.floor(price / 2))
      expect((await h.service.refresh(code)).stateReason).toBe('underpaid')
      h.provider.pay(invoiceId, price - Math.floor(price / 2))
      h.provider.confirm(invoiceId)
      await h.service.refresh(code)
      expect(await h.service.refresh(code)).toMatchObject({ state: 'needs_resolution', stateReason: 'underpaid', receipt: null })
    })

    it('ignores a stale provider read that would make a detected payment look unpaid again', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      h.provider.pay(invoiceId, h.provider.invoices.get(invoiceId)!.price_zatoshis)
      expect((await h.service.refresh(code)).state).toBe('payment_detected')
      const inv = h.provider.invoices.get(invoiceId)!
      inv.status = 'pending'
      inv.received_zatoshis = 0
      expect(await h.service.refresh(code)).toMatchObject({ state: 'payment_detected', payment: null })
    })

    it('a payment arriving after local expiry is never granted', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      h.provider.expire(invoiceId)
      expect((await h.service.refresh(code)).state).toBe('expired')
      const inv = h.provider.invoices.get(invoiceId)!
      inv.received_zatoshis = inv.price_zatoshis
      inv.status = 'confirmed'
      expect(await h.service.refresh(code)).toMatchObject({ state: 'needs_resolution', stateReason: 'payment_after_expiry', receipt: null })
      expect((await h.service.refresh(code)).receipt).toBeNull()
    })

    it('requesting a refund of a fulfilled order revokes the receipt in the same step', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      h.provider.pay(invoiceId, h.provider.invoices.get(invoiceId)!.price_zatoshis)
      h.provider.confirm(invoiceId)
      expect((await h.service.refresh(code)).state).toBe('fulfilled')
      const view = await h.service.requestRefund(code, validUnifiedAddress())
      expect(view).toMatchObject({ state: 'needs_resolution', stateReason: 'refund_requested', receipt: { revoked: true } })
      expect(await h.service.refresh(code)).toMatchObject({ state: 'needs_resolution', receipt: { revoked: true } })
    })

    it('confirmed below the quoted amount (provider tolerance) is not granted', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      const price = h.provider.invoices.get(invoiceId)!.price_zatoshis
      h.provider.pay(invoiceId, Math.ceil(price * 0.996))
      h.provider.confirm(invoiceId)
      expect(await h.service.refresh(code)).toMatchObject({ state: 'needs_resolution', stateReason: 'confirmed_below_quote', receipt: null })
    })

    it('an expired zero-paid invoice needs a deliberate new quote; a late payment on it then needs resolution', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      h.provider.expire(invoiceId)
      const expired = await h.service.refresh(code)
      expect(expired).toMatchObject({ state: 'expired', payment: null })
      expect((await h.service.ensureInvoice(code)).state).toBe('expired')
      expect(h.provider.calls.create).toBe(1)
      const fresh = await h.service.ensureInvoice(code, { newQuote: true })
      expect(fresh.state).toBe('awaiting_payment')
      expect(fresh.payment!.address).not.toBe(h.provider.invoices.get(invoiceId)!.payment_address)
      h.provider.pay(invoiceId, h.provider.invoices.get(invoiceId)!.price_zatoshis)
      const late = await h.service.refresh(code)
      expect(late).toMatchObject({ state: 'needs_resolution', stateReason: 'payment_on_replaced_quote', payment: null })
    })

    it('a payment after cancellation is not granted', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      expect((await h.service.cancel(code)).state).toBe('cancelled')
      h.provider.pay(invoiceId, h.provider.invoices.get(invoiceId)!.price_zatoshis)
      h.provider.confirm(invoiceId)
      expect(await h.service.refresh(code)).toMatchObject({ state: 'needs_resolution', stateReason: 'payment_after_cancel', receipt: null })
      expect(await h.service.refresh(code)).toMatchObject({ state: 'needs_resolution', stateReason: 'payment_after_cancel', receipt: null })
      await expectCode(h.service.cancel(code), 'action_not_allowed')
    })

    it('a txid already bound to one order quarantines the other instead of granting twice', async () => {
      const h = harness(await makeStore())
      const a = await paidOrder(h)
      const b = await paidOrder(h)
      const txid = h.provider.pay(a.invoiceId, h.provider.invoices.get(a.invoiceId)!.price_zatoshis)
      h.provider.confirm(a.invoiceId)
      expect((await h.service.refresh(a.code)).state).toBe('fulfilled')
      h.provider.reportTxid(b.invoiceId, txid, h.provider.invoices.get(b.invoiceId)!.price_zatoshis)
      expect(await h.service.refresh(b.code)).toMatchObject({ state: 'quarantined', stateReason: 'payment_reused_by_another_order', receipt: null })
    })

    it('a provider refund after fulfilment revokes the receipt', async () => {
      const h = harness(await makeStore())
      const { code, invoiceId } = await paidOrder(h)
      h.provider.pay(invoiceId, h.provider.invoices.get(invoiceId)!.price_zatoshis)
      h.provider.confirm(invoiceId)
      await h.service.refresh(code)
      h.provider.refund(invoiceId)
      expect(await h.service.refresh(code)).toMatchObject({ state: 'refunded', receipt: { revoked: true } })
    })

    it('an unknown provider status or a changed price stops the order for reconciliation', async () => {
      const h = harness(await makeStore())
      const one = await paidOrder(h)
      h.provider.setStatus(one.invoiceId, 'mystery')
      expect((await h.service.refresh(one.code)).state).toBe('reconciliation_required')
      const two = await paidOrder(h)
      h.provider.invoices.get(two.invoiceId)!.reported_price_zatoshis = 1
      expect(await h.service.refresh(two.code)).toMatchObject({ state: 'reconciliation_required', stateReason: 'provider_price_changed' })
    })

    it('a store failure before the claim means no provider call; a failure after it means no second invoice', async () => {
      let failing = false
      const base = await makeStore()
      const h = harness(base, {
        claimTtlMs: 5_000,
        wrapStore: (s) => ({
          durable: s.durable,
          insertOrder: (o) => s.insertOrder(o),
          findByCredentialHash: (x) => s.findByCredentialHash(x),
          update: (id, fn) => (failing ? Promise.reject(new StoreUnavailableError()) : s.update(id, fn)),
        }),
      })
      const { recoveryCode } = await h.service.createOrder()
      failing = true
      await expect(h.service.ensureInvoice(recoveryCode)).rejects.toBeInstanceOf(StoreUnavailableError)
      expect(h.provider.calls.create).toBe(0)

      // Claim succeeds, provider creates, then the store dies before the invoice is bound.
      failing = false
      const realUpdate = h.store.update.bind(h.store)
      let updates = 0
      h.store.update = ((id: string, fn: never) => (++updates === 2 ? Promise.reject(new StoreUnavailableError()) : realUpdate(id, fn))) as OrderStore['update']
      await expect(h.service.ensureInvoice(recoveryCode)).rejects.toBeInstanceOf(StoreUnavailableError)
      expect(h.provider.calls.create).toBe(1)
      h.store.update = realUpdate
      await expectCode(h.service.ensureInvoice(recoveryCode), 'invoice_creation_in_progress')
      h.clock.t += 6_000
      expect((await h.service.ensureInvoice(recoveryCode)).state).toBe('reconciliation_required')
      expect(h.provider.calls.create).toBe(1)
    })
  })
}
