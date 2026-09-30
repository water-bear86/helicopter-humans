// Order service: binds one private order to CipherPay invoices and grants the preorder at most once.
//
// Trust rules, in one place:
// - The buyer is identified only by the recovery code (hashed at rest). Invoice ids, memo codes and
//   txids are public metadata and are never accepted from the buyer at all.
// - Price, currency and product come from the server-side offer, copied onto the order when it is
//   created. Every later provider read is checked against the order's stored terms and the invoice's
//   original values, never against whatever the global offer says now.
// - The provider's invoice id is stored when we create it and is the only invoice this order reads.
// - Nothing is payable until the provider's GET has confirmed the integer amount and the payment URI
//   has exactly one recipient, our invoice address, for exactly that amount.
// - The buyer's deadline is the provider expiry at creation and never moves. A payment grants only if
//   the provider detected it by that deadline; it may confirm later.
// - Only `confirmed` with the full amount on the active invoice grants, inside the order lock, once.
// - A replacement quote is created only after every earlier invoice was read and shows nothing paid.
import { shieldedAddressKind, maskAddress } from './address.js'
import type { CreatedInvoice, InvoiceProvider, ProviderInvoice, ReadOutcome } from './cipherpay.js'
import { hashRecoveryCode, isRecoveryCode, newId, newRecoveryCode } from './credential.js'
import { providerAmount, type Offer } from './offer.js'
import { zatoshisToZec } from '../payments/zec.js'
import type { InvoicePatch, InvoiceRow, OrderChanges, OrderRow, OrderSnapshot, OrderState, OrderStore, OrderTx } from './store.js'
import { checkPaymentUri } from './zip321.js'

export type CheckoutErrorCode =
  | 'order_not_found'
  | 'invoice_creation_in_progress'
  | 'action_not_allowed'
  | 'quote_limit_reached'
  | 'invalid_refund_address'
  | 'nothing_to_refund'
  | 'refund_already_requested'

export class CheckoutError extends Error {
  constructor(
    readonly code: CheckoutErrorCode,
    readonly httpStatus: number,
  ) {
    super(code)
    this.name = 'CheckoutError'
  }
}

export type Notice = 'provider_unavailable' | 'provider_rejected' | 'invoice_creation_outcome_unknown'

export interface OrderView {
  state: OrderState
  stateReason: string | null
  notice: Notice | null
  offer: { id: string; version: string; title: string; priceLabel: string; approved: boolean }
  createdAt: string
  // Present only while the validated invoice is payable. Never for any other state.
  payment: {
    amountZec: string
    amountZatoshis: number
    address: string
    uri: string
    expiresAt: string
    reference: string
  } | null
  received: { quotedZec: string | null; receivedZec: string; providerStatus: string } | null
  receipt: { id: string; createdAt: string; revoked: boolean } | null
  refundRequest: { createdAt: string; address: string } | null
  actions: { createInvoice: boolean; refresh: boolean; newQuote: boolean; cancel: boolean; requestRefund: boolean }
}

export interface CheckoutServiceOptions {
  store: OrderStore
  provider: InvoiceProvider
  offer: Offer
  now?: () => number
  // How long one request may hold the invoice-creation claim. Must exceed the provider timeout.
  claimTtlMs?: number
  maxQuotesPerOrder?: number
}

// States that a provider read never moves an order out of (only into something more severe). An
// operator resolves these. `needs_resolution` is here on purpose: once ZEC arrived in a way we do not
// grant (after cancel, after expiry, partial), a later confirmation must not quietly grant it.
const STICKY: ReadonlySet<OrderState> = new Set(['needs_resolution', 'reconciliation_required', 'quarantined', 'refunded'])

// Provider status order, used to ignore a read older than what is already stored (two refreshes
// racing: the slower one read the provider first). Unknown statuses are never treated as stale.
const STATUS_RANK: Record<string, number> = { created: 0, pending: 1, underpaid: 2, expired: 2, detected: 3, confirmed: 4, refunded: 5 }
function isStaleRead(row: InvoiceRow, p: ProviderInvoice): boolean {
  if (p.receivedZatoshis < row.receivedZatoshis) return true
  const before = STATUS_RANK[row.providerStatus]
  const after = STATUS_RANK[p.status]
  return before !== undefined && after !== undefined && after < before
}
const REPLACEABLE: ReadonlySet<OrderState> = new Set(['expired', 'quote_rejected'])
const CANCELLABLE: ReadonlySet<OrderState> = new Set(['new', 'quote_unverified', 'awaiting_payment', 'expired', 'quote_rejected'])

// Severity when several invoices of one order disagree: the worst finding wins.
const SEVERITY: Record<OrderState, number> = {
  new: 0,
  creating_invoice: 0,
  quote_unverified: 1,
  awaiting_payment: 1,
  expired: 1,
  quote_rejected: 1,
  cancelled: 2,
  payment_detected: 3,
  fulfilled: 4,
  needs_resolution: 5,
  refunded: 6,
  reconciliation_required: 7,
  quarantined: 8,
}

interface Finding {
  state: OrderState
  reason: string | null
}

function worst(a: Finding, b: Finding): Finding {
  return SEVERITY[b.state] > SEVERITY[a.state] ? b : a
}

function totalReceived(snapshot: OrderSnapshot): number {
  return snapshot.invoices.reduce((sum, i) => sum + i.receivedZatoshis, 0)
}

// Upstream stamps whole seconds; compare at that precision (storage may round sub-second parts).
function seconds(timestamp: string): number {
  return Math.floor(Date.parse(timestamp) / 1000)
}

// Terms the provider reports must still be the ones this order and invoice were created with.
function termsMismatch(order: OrderRow, row: InvoiceRow, p: ProviderInvoice): string | null {
  if (p.currency !== order.fiatCurrency || p.amount !== providerAmount(order)) return 'fiat_terms_changed'
  if (p.priceZec !== row.priceZec) return 'price_zec_changed'
  return null
}

// Whether a received payment beat the buyer's deadline, by the provider's own detection stamp. The
// provider's moving `expires_at` plays no part. Missing or contradictory stamps are `unknown`.
function paymentTiming(row: InvoiceRow, p: ProviderInvoice): 'on_time' | 'late' | 'unknown' {
  if (!p.detectedAt) return 'unknown'
  if (p.status === 'confirmed' && (!p.confirmedAt || Date.parse(p.confirmedAt) < Date.parse(p.detectedAt))) return 'unknown'
  return seconds(p.detectedAt) <= seconds(row.quoteExpiresAt) ? 'on_time' : 'late'
}

// Findings for a payment that arrived but must not be granted automatically.
function untimely(timing: 'late' | 'unknown'): Finding {
  return { state: 'needs_resolution', reason: timing === 'late' ? 'payment_after_expiry' : 'payment_timing_unknown' }
}

export function createCheckoutService(options: CheckoutServiceOptions) {
  const { store, provider, offer } = options
  const now = options.now ?? Date.now
  const claimTtlMs = options.claimTtlMs ?? 30_000
  const maxQuotes = options.maxQuotesPerOrder ?? 3
  const iso = () => new Date(now()).toISOString()

  async function load(code: string): Promise<OrderSnapshot> {
    if (!isRecoveryCode(code)) throw new CheckoutError('order_not_found', 404)
    const snapshot = await store.findByCredentialHash(hashRecoveryCode(code))
    if (!snapshot) throw new CheckoutError('order_not_found', 404)
    return snapshot
  }

  async function reload(orderId: string): Promise<OrderSnapshot> {
    return store.update(orderId, (s) => ({ result: s }))
  }

  function view(s: OrderSnapshot, notice: Notice | null = null): OrderView {
    const { order } = s
    const active = s.invoices.find((i) => i.providerInvoiceId === order.activeInvoiceId) ?? null
    const payable =
      order.state === 'awaiting_payment' && active?.paymentUri && active.priceZatoshis !== null && Date.parse(active.quoteExpiresAt) > now() ? active : null
    const received = totalReceived(s)
    return {
      state: order.state,
      stateReason: order.stateReason,
      notice,
      offer: { id: order.offerId, version: order.offerVersion, title: offer.title, priceLabel: offer.priceLabel, approved: offer.approved },
      createdAt: order.createdAt,
      payment: payable
        ? {
            amountZec: zatoshisToZec(String(payable.priceZatoshis)),
            amountZatoshis: payable.priceZatoshis as number,
            address: payable.paymentAddress,
            uri: payable.paymentUri as string,
            expiresAt: payable.quoteExpiresAt,
            reference: payable.memoCode,
          }
        : null,
      received:
        active && (received > 0 || ['payment_detected', 'needs_resolution', 'fulfilled'].includes(order.state))
          ? {
              quotedZec: active.priceZatoshis === null ? null : zatoshisToZec(String(active.priceZatoshis)),
              receivedZec: zatoshisToZec(String(received)),
              providerStatus: active.providerStatus,
            }
          : null,
      receipt: s.receipt ? { id: s.receipt.id, createdAt: s.receipt.createdAt, revoked: s.receipt.revokedAt !== null } : null,
      refundRequest: s.refundRequest ? { createdAt: s.refundRequest.createdAt, address: maskAddress(s.refundRequest.refundAddress) } : null,
      actions: {
        createInvoice: order.state === 'new',
        refresh: s.invoices.length > 0 || order.state === 'creating_invoice',
        newQuote: REPLACEABLE.has(order.state) && order.quoteCount < maxQuotes,
        cancel: CANCELLABLE.has(order.state),
        requestRefund: received > 0 && !s.refundRequest && order.state !== 'refunded',
      },
    }
  }

  // A claim whose holder never came back: the provider may or may not have created an invoice.
  function staleClaimChanges(s: OrderSnapshot): OrderChanges | undefined {
    const o = s.order
    if (o.state !== 'creating_invoice' || Date.parse(o.claimExpiresAt ?? '') > now()) return undefined
    return {
      order: { state: 'reconciliation_required', stateReason: 'invoice_creation_outcome_unknown', claimToken: null, claimExpiresAt: null, updatedAt: iso() },
    }
  }

  // ---- Validation of provider data ------------------------------------------------------------

  function observed(row: InvoiceRow, p: ProviderInvoice): InvoicePatch {
    return {
      providerInvoiceId: row.providerInvoiceId,
      providerStatus: p.status,
      receivedZatoshis: p.receivedZatoshis,
      providerExpiresAt: p.expiresAt,
      detectedAt: p.detectedAt,
      confirmedAt: p.confirmedAt,
      updatedAt: iso(),
    }
  }

  // First read after creation: the only way an invoice becomes payable.
  function verifyNewInvoice(order: OrderRow, row: InvoiceRow, p: ProviderInvoice): { patch: InvoicePatch; finding: Finding } {
    const base = observed(row, p)
    const reject = (reason: string, state: OrderState = 'quote_rejected') => ({
      patch: { ...base, rejectedReason: reason },
      finding: { state, reason },
    })
    // Someone paid an address we never showed, or the invoice already moved on: an operator must look.
    if (p.status !== 'pending' || p.receivedZatoshis !== 0) return reject(`unexpected_status_before_display:${p.status}`, p.receivedZatoshis > 0 ? 'needs_resolution' : 'reconciliation_required')
    if (p.currency !== order.fiatCurrency || p.amount !== providerAmount(order)) return reject('fiat_terms_mismatch')
    if (p.priceZec !== row.priceZec) return reject('price_changed_since_create')
    // Upstream computes price_zatoshis = round(price_zec * 1e8) in f64; recompute the same way.
    if (Math.round(p.priceZec * 1e8) !== p.priceZatoshis) return reject('price_zatoshis_inconsistent')
    if (seconds(p.expiresAt) !== seconds(row.quoteExpiresAt)) return reject('expiry_changed_since_create')
    const uri = checkPaymentUri(p.zcashUri, { address: row.paymentAddress, amountZatoshis: p.priceZatoshis, memoCode: row.memoCode })
    if (!uri.ok) return reject(`payment_uri_${uri.reason}`)
    return {
      patch: { ...base, priceZatoshis: p.priceZatoshis, paymentUri: uri.uri, rejectedReason: null },
      finding: { state: 'awaiting_payment', reason: null },
    }
  }

  // Later reads: identity, terms and price must not have changed; timing and status decide the state.
  async function classify(
    s: OrderSnapshot,
    row: InvoiceRow,
    p: ProviderInvoice,
    tx: OrderTx,
  ): Promise<{ patch: InvoicePatch; finding: Finding; grant: boolean }> {
    const patch = observed(row, p)
    const inconsistent = (reason: string) => ({ patch, finding: { state: 'reconciliation_required' as const, reason }, grant: false })
    const price = row.priceZatoshis as number
    const terms = termsMismatch(s.order, row, p)
    if (terms) return inconsistent(`provider_${terms}`)
    if (p.priceZatoshis !== price) return inconsistent('provider_price_changed')
    const uri = checkPaymentUri(p.zcashUri, { address: row.paymentAddress, amountZatoshis: price, memoCode: row.memoCode })
    if (!uri.ok) return inconsistent(`provider_uri_changed:${uri.reason}`)
    // Upstream moves the deadline only when its scanner records a payment. An unpaid invoice whose
    // deadline moved is not the quote the buyer saw.
    if (p.status === 'pending' && p.receivedZatoshis === 0 && seconds(p.expiresAt) !== seconds(row.quoteExpiresAt)) return inconsistent('provider_deadline_changed')

    // A txid bound to another order is never granted twice. Several txids on one invoice are fine:
    // each is claimed by this order in turn.
    if (p.detectedTxid) {
      const owner = await tx.claimTxid(p.detectedTxid, s.order.id, row.providerInvoiceId, iso())
      if (owner !== s.order.id) return { patch, finding: { state: 'quarantined', reason: 'payment_reused_by_another_order' }, grant: false }
    }

    const active = row.providerInvoiceId === s.order.activeInvoiceId
    const received = p.receivedZatoshis
    if (!active) {
      const finding: Finding = received > 0 ? { state: 'needs_resolution', reason: 'payment_on_replaced_quote' } : { state: 'new', reason: null }
      return { patch, finding, grant: false }
    }
    if (s.order.state === 'expired' && received > 0) {
      return { patch, finding: { state: 'needs_resolution', reason: 'payment_after_expiry' }, grant: false }
    }
    if (s.order.state === 'cancelled') {
      const finding: Finding = received > 0 ? { state: 'needs_resolution', reason: 'payment_after_cancel' } : { state: 'cancelled', reason: s.order.stateReason }
      return { patch, finding, grant: false }
    }
    // Judged on every read, so a missed `expired` read cannot turn a late payment into a grant.
    const timing = paymentTiming(row, p)
    switch (p.status) {
      case 'pending':
        return { patch, finding: received > 0 ? { state: 'needs_resolution', reason: 'partial_payment' } : { state: 'awaiting_payment', reason: null }, grant: false }
      case 'underpaid':
        return { patch, finding: { state: 'needs_resolution', reason: 'underpaid' }, grant: false }
      case 'detected':
        if (timing !== 'on_time') return { patch, finding: untimely(timing), grant: false }
        return { patch, finding: { state: 'payment_detected', reason: null }, grant: false }
      case 'confirmed':
        if (timing !== 'on_time') return { patch, finding: untimely(timing), grant: false }
        if (received < price) return { patch, finding: { state: 'needs_resolution', reason: 'confirmed_below_quote' }, grant: false }
        return { patch, finding: { state: 'fulfilled', reason: received > price ? 'overpaid' : null }, grant: true }
      case 'expired':
        return { patch, finding: received > 0 ? { state: 'needs_resolution', reason: 'expired_with_payment' } : { state: 'expired', reason: null }, grant: false }
      case 'refunded':
        return { patch, finding: { state: 'refunded', reason: 'provider_marked_refunded' }, grant: false }
      default:
        return { patch, finding: { state: 'reconciliation_required', reason: `unknown_provider_status:${p.status.slice(0, 32)}` }, grant: false }
    }
  }

  function sameIdentity(row: InvoiceRow, p: ProviderInvoice): boolean {
    return p.id === row.providerInvoiceId && p.memoCode === row.memoCode && p.paymentAddress === row.paymentAddress
  }

  // Applies provider reads to the order atomically. Called with the order locked.
  // `derived` is what the active invoice says now; `other` collects findings from every other read
  // (replaced quotes, missing or changed invoices). Other findings can only make the outcome worse.
  async function decide(s: OrderSnapshot, reads: Map<string, ReadOutcome>, tx: OrderTx): Promise<OrderChanges> {
    const o = s.order
    const updates: InvoicePatch[] = []
    const baseline: Finding = { state: 'new', reason: null }
    let other = baseline
    let derived: Finding | undefined
    let grant: InvoiceRow | undefined

    for (const row of s.invoices) {
      const read = reads.get(row.providerInvoiceId)
      if (!read || read.kind === 'unavailable') continue
      const isActive = row.providerInvoiceId === o.activeInvoiceId
      if (read.kind === 'not_found') {
        other = worst(other, { state: 'reconciliation_required', reason: 'provider_invoice_missing' })
        continue
      }
      const p = read.invoice
      if (!sameIdentity(row, p)) {
        other = worst(other, { state: 'reconciliation_required', reason: 'provider_invoice_identity_changed' })
        continue
      }
      if (row.priceZatoshis === null) {
        const checked = verifyNewInvoice(o, row, p)
        updates.push(checked.patch)
        if (isActive) derived = checked.finding
        else if (checked.finding.state !== 'quote_rejected') other = worst(other, checked.finding)
        continue
      }
      if (isStaleRead(row, p)) continue
      const c = await classify(s, row, p, tx)
      updates.push(c.patch)
      if (isActive) {
        derived = c.finding
        if (c.grant) grant = { ...row, receivedZatoshis: p.receivedZatoshis }
      } else {
        other = worst(other, c.finding)
      }
    }

    const changes: OrderChanges = { updateInvoices: updates }
    const stamp = iso()
    const move = (f: Finding) => {
      if (f.state !== o.state || f.reason !== o.stateReason) changes.order = { state: f.state, stateReason: f.reason, updatedAt: stamp }
    }

    if (o.state === 'fulfilled') {
      // A granted order moves only for a provider refund or a severe finding, and loses its receipt.
      const after = worst(other, derived ?? baseline)
      if (SEVERITY[after.state] >= SEVERITY.refunded) {
        move(after)
        changes.revokeReceiptAt = stamp
      }
      return changes
    }
    if (STICKY.has(o.state)) {
      const after = worst(other, derived ?? baseline)
      if (SEVERITY[after.state] > SEVERITY[o.state]) move(after)
      return changes
    }

    let next = worst(derived ?? { state: o.state, reason: o.stateReason }, other)
    if (next.state === 'fulfilled') {
      if (grant && grant.priceZatoshis !== null && !s.receipt) {
        changes.insertReceipt = {
          id: newId(),
          orderId: o.id,
          providerInvoiceId: grant.providerInvoiceId,
          offerId: o.offerId,
          offerVersion: o.offerVersion,
          fiatAmountCents: o.fiatAmountCents,
          priceZatoshis: grant.priceZatoshis,
          receivedZatoshis: grant.receivedZatoshis,
          createdAt: stamp,
          revokedAt: null,
        }
      } else {
        next = { state: 'reconciliation_required', reason: 'fulfilment_preconditions_failed' }
      }
    }
    move(next)
    return changes
  }

  async function readInvoices(s: OrderSnapshot): Promise<{ reads: Map<string, ReadOutcome>; unavailable: boolean }> {
    const reads = new Map<string, ReadOutcome>()
    let unavailable = false
    // Bounded: at most maxQuotes invoices per order, one request each, each with the client timeout.
    for (const row of s.invoices) {
      if (row.rejectedReason) continue
      const read = await provider.getInvoice(row.providerInvoiceId)
      if (read.kind === 'unavailable') unavailable = true
      reads.set(row.providerInvoiceId, read)
    }
    return { reads, unavailable }
  }

  async function refreshSnapshot(s: OrderSnapshot): Promise<OrderView> {
    if (staleClaimChanges(s)) {
      await store.update(s.order.id, (cur) => ({ changes: staleClaimChanges(cur), result: undefined }))
      return view(await reload(s.order.id))
    }
    if (s.invoices.length === 0) return view(s)
    const { reads, unavailable } = await readInvoices(s)
    await store.update(s.order.id, async (cur, tx) => ({ changes: await decide(cur, reads, tx), result: undefined }))
    return view(await reload(s.order.id), unavailable ? 'provider_unavailable' : null)
  }

  function invoiceRow(orderId: string, created: CreatedInvoice, stamp: string, rejectedReason: string | null): InvoiceRow {
    return {
      providerInvoiceId: created.invoiceId,
      orderId,
      memoCode: created.memoCode,
      paymentAddress: created.paymentAddress,
      priceZec: created.priceZec,
      priceZatoshis: null,
      paymentUri: null,
      quoteExpiresAt: created.expiresAt,
      providerExpiresAt: created.expiresAt,
      detectedAt: null,
      confirmedAt: null,
      providerStatus: 'created',
      receivedZatoshis: 0,
      rejectedReason,
      createdAt: stamp,
      updatedAt: stamp,
    }
  }

  return {
    async createOrder(): Promise<{ recoveryCode: string; order: OrderView }> {
      const recoveryCode = newRecoveryCode()
      const stamp = iso()
      await store.insertOrder({
        id: newId(),
        credentialHash: hashRecoveryCode(recoveryCode),
        offerId: offer.id,
        offerVersion: offer.version,
        fiatCurrency: offer.fiatCurrency,
        fiatAmountCents: offer.fiatAmountCents,
        state: 'new',
        stateReason: null,
        activeInvoiceId: null,
        quoteCount: 0,
        claimToken: null,
        claimExpiresAt: null,
        createdAt: stamp,
        updatedAt: stamp,
      })
      return { recoveryCode, order: view((await load(recoveryCode)) as OrderSnapshot) }
    },

    async getOrder(code: string): Promise<OrderView> {
      return view(await load(code))
    },

    // Create the order's invoice, or return the existing one. `newQuote` deliberately replaces an
    // expired zero-paid or rejected quote; it is never implied by a retry.
    async ensureInvoice(code: string, { newQuote = false } = {}): Promise<OrderView> {
      const s = await load(code)
      const orderId = s.order.id
      const token = newId()
      // Before a replacement, read every earlier invoice now: money may have reached one since it was
      // last seen. The reads happen outside any transaction; the claim below applies them to the
      // locked, current order and rechecks it, so concurrent refresh, cancel or refund stay safe.
      const prior = newQuote ? await readInvoices(s) : undefined
      type Claim = 'unchanged' | 'unreconciled' | 'in_progress' | 'not_allowed' | 'quote_limit' | { previous: OrderState }
      const claim = await store.update<Claim>(orderId, async (cur, tx) => {
        const stale = staleClaimChanges(cur)
        if (stale) return { changes: stale, result: 'unchanged' }
        const reconciled = prior ? await decide(cur, prior.reads, tx) : undefined
        const o = { ...cur.order, ...reconciled?.order }
        const keep = (result: Claim) => ({ changes: reconciled, result })
        if (o.state === 'creating_invoice') return keep('in_progress')
        if (newQuote && !REPLACEABLE.has(o.state)) return keep(REPLACEABLE.has(cur.order.state) ? 'unchanged' : 'not_allowed')
        if (!newQuote && o.state !== 'new') return keep('unchanged')
        // Unavailable, or an invoice we did not read: we cannot know nothing was paid. No new quote.
        const unread = cur.invoices.some((i) => !i.rejectedReason && prior?.reads.get(i.providerInvoiceId)?.kind !== 'ok')
        if (prior && (prior.unavailable || unread)) return keep('unreconciled')
        // Terms are the order's; a changed global offer never reprices or relabels an existing order.
        if (o.offerId !== offer.id || o.offerVersion !== offer.version) return keep('not_allowed')
        if (o.quoteCount >= maxQuotes) return keep('quote_limit')
        return {
          changes: {
            ...reconciled,
            order: {
              ...reconciled?.order,
              state: 'creating_invoice',
              stateReason: null,
              claimToken: token,
              claimExpiresAt: new Date(now() + claimTtlMs).toISOString(),
              quoteCount: o.quoteCount + 1,
              updatedAt: iso(),
            },
          },
          result: { previous: o.state },
        }
      })
      if (claim === 'in_progress') throw new CheckoutError('invoice_creation_in_progress', 409)
      if (claim === 'not_allowed') throw new CheckoutError('action_not_allowed', 409)
      if (claim === 'quote_limit') throw new CheckoutError('quote_limit_reached', 409)
      if (claim === 'unchanged') return view(await reload(orderId))
      if (claim === 'unreconciled') return view(await reload(orderId), 'provider_unavailable')

      const terms = s.order
      const outcome = await provider.createInvoice({ productName: offer.providerProductName, amount: providerAmount(terms), currency: terms.fiatCurrency })

      if (outcome.kind !== 'created') {
        // 4xx: certainly nothing created, so the order returns to where it was. Anything else may have
        // created an invoice we cannot see: stop, never create a second one automatically.
        const rejected = outcome.kind === 'rejected'
        await store.update(orderId, (cur) => {
          if (cur.order.state !== 'creating_invoice' || cur.order.claimToken !== token) return { result: undefined }
          return {
            changes: {
              order: rejected
                ? { state: claim.previous, stateReason: `provider_rejected_http_${outcome.httpStatus}`, claimToken: null, claimExpiresAt: null, updatedAt: iso() }
                : { state: 'reconciliation_required', stateReason: `invoice_creation_outcome_unknown:${outcome.reason}`, claimToken: null, claimExpiresAt: null, updatedAt: iso() },
            },
            result: undefined,
          }
        })
        return view(await reload(orderId), rejected ? 'provider_rejected' : 'invoice_creation_outcome_unknown')
      }

      const created = outcome.invoice
      const termsOk = created.currency === terms.fiatCurrency && created.amount === providerAmount(terms)
      await store.update(orderId, (cur) => {
        const stamp = iso()
        const row = invoiceRow(orderId, created, stamp, termsOk ? null : 'fiat_terms_mismatch')
        if (cur.order.state !== 'creating_invoice' || cur.order.claimToken !== token) {
          // Our claim expired and the order moved on. Keep the invoice on record for the operator.
          return { changes: { insertInvoice: row, order: { stateReason: 'invoice_created_after_claim_expired', updatedAt: stamp } }, result: undefined }
        }
        return {
          changes: {
            insertInvoice: row,
            order: {
              state: termsOk ? 'quote_unverified' : 'quote_rejected',
              stateReason: termsOk ? null : 'fiat_terms_mismatch',
              activeInvoiceId: created.invoiceId,
              claimToken: null,
              claimExpiresAt: null,
              updatedAt: stamp,
            },
          },
          result: undefined,
        }
      })
      return refreshSnapshot(await reload(orderId))
    },

    // User-triggered status check. One bounded read per invoice of this order; no polling loop.
    async refresh(code: string): Promise<OrderView> {
      return refreshSnapshot(await load(code))
    },

    async cancel(code: string): Promise<OrderView> {
      const s = await load(code)
      const ok = await store.update(s.order.id, (cur) => {
        if (!CANCELLABLE.has(cur.order.state) || totalReceived(cur) > 0) return { result: false }
        return { changes: { order: { state: 'cancelled', stateReason: 'buyer_cancelled', updatedAt: iso() } }, result: true }
      })
      if (!ok) throw new CheckoutError('action_not_allowed', 409)
      return view(await reload(s.order.id))
    },

    // Records where the buyer wants ZEC returned. The refund itself is manual, from the operator's
    // wallet; no key ever reaches this app.
    async requestRefund(code: string, refundAddress: unknown): Promise<OrderView> {
      if (typeof refundAddress !== 'string' || !shieldedAddressKind(refundAddress.trim())) throw new CheckoutError('invalid_refund_address', 400)
      const address = refundAddress.trim()
      const s = await load(code)
      const result = await store.update(s.order.id, (cur) => {
        if (cur.refundRequest) return { result: 'duplicate' as const }
        const received = totalReceived(cur)
        if (received === 0 || cur.order.state === 'refunded') return { result: 'nothing' as const }
        // Asking for the money back gives up the preorder: the receipt is revoked in the same
        // transaction, and the order waits for the operator's manual refund.
        const stamp = iso()
        const severe = SEVERITY[cur.order.state] > SEVERITY.needs_resolution
        return {
          changes: {
            insertRefundRequest: { id: newId(), orderId: cur.order.id, refundAddress: address, receivedZatoshis: received, createdAt: stamp },
            order: severe ? undefined : { state: 'needs_resolution', stateReason: 'refund_requested', updatedAt: stamp },
            revokeReceiptAt: cur.receipt && !cur.receipt.revokedAt ? stamp : undefined,
          },
          result: 'ok' as const,
        }
      })
      if (result === 'duplicate') throw new CheckoutError('refund_already_requested', 409)
      if (result === 'nothing') throw new CheckoutError('nothing_to_refund', 409)
      return view(await reload(s.order.id))
    },
  }
}

export type CheckoutService = ReturnType<typeof createCheckoutService>
