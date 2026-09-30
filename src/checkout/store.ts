// Order/receipt store contract. Every state change goes through `update`, which runs the caller's
// decision against a locked, current snapshot and applies the result atomically. PostgreSQL
// (store-postgres.ts) is the only durable implementation; MemoryOrderStore is for local fixtures and
// tests and enforces the same uniqueness rules so the two cannot quietly diverge.

export type OrderState =
  | 'new' // order and credential exist, no invoice yet
  | 'creating_invoice' // a request holds the creation claim and is talking to the provider
  | 'quote_unverified' // provider created an invoice; we have not yet validated its integer amount/URI
  | 'awaiting_payment' // validated invoice, payable until it expires
  | 'payment_detected' // provider saw a payment in the mempool; nothing granted yet
  | 'fulfilled' // confirmed and receipt written, exactly once
  | 'expired' // provider expired the invoice with nothing received; a deliberate new quote may follow
  | 'quote_rejected' // invoice failed our checks before any payment detail was shown
  | 'needs_resolution' // ZEC arrived but not in a grantable way (underpaid, late, after cancel)
  | 'reconciliation_required' // provider outcome unknown or inconsistent; operator must look
  | 'quarantined' // payment evidence already bound to another order
  | 'cancelled' // buyer cancelled before any payment was received
  | 'refunded' // provider reports the invoice refunded

export interface OrderRow {
  id: string
  credentialHash: string
  offerId: string
  offerVersion: string
  fiatCurrency: 'USD'
  fiatAmountCents: number
  state: OrderState
  stateReason: string | null
  activeInvoiceId: string | null
  quoteCount: number
  claimToken: string | null
  claimExpiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface InvoiceRow {
  providerInvoiceId: string
  orderId: string
  memoCode: string
  paymentAddress: string
  // Provider's float, kept for audit only. Never used to decide a payable amount.
  priceZec: number
  // Integer from the provider's GET; null until that read validated the invoice.
  priceZatoshis: number | null
  // Canonical single-recipient URI rebuilt from validated values; null until validated.
  paymentUri: string | null
  expiresAt: string
  providerStatus: string
  receivedZatoshis: number
  rejectedReason: string | null
  createdAt: string
  updatedAt: string
}

export interface ReceiptRow {
  id: string
  orderId: string
  providerInvoiceId: string
  offerId: string
  offerVersion: string
  fiatAmountCents: number
  priceZatoshis: number
  receivedZatoshis: number
  createdAt: string
  revokedAt: string | null
}

export interface RefundRequestRow {
  id: string
  orderId: string
  refundAddress: string
  receivedZatoshis: number
  createdAt: string
}

export interface OrderSnapshot {
  order: OrderRow
  invoices: InvoiceRow[]
  receipt: ReceiptRow | null
  refundRequest: RefundRequestRow | null
}

export type InvoicePatch = Pick<InvoiceRow, 'providerInvoiceId'> &
  Partial<Pick<InvoiceRow, 'priceZatoshis' | 'paymentUri' | 'providerStatus' | 'receivedZatoshis' | 'rejectedReason' | 'expiresAt' | 'updatedAt'>>

export interface OrderChanges {
  order?: Partial<Omit<OrderRow, 'id' | 'credentialHash' | 'createdAt' | 'offerId' | 'offerVersion' | 'fiatAmountCents' | 'fiatCurrency'>>
  insertInvoice?: InvoiceRow
  updateInvoices?: InvoicePatch[]
  insertReceipt?: ReceiptRow
  revokeReceiptAt?: string
  insertRefundRequest?: RefundRequestRow
}

export interface OrderTx {
  // Records that `txid` paid `invoiceId` of `orderId`, unless another order already holds it.
  // Returns the order that owns the txid after the call. Atomic across concurrent callers.
  claimTxid(txid: string, orderId: string, invoiceId: string, now: string): Promise<string>
}

export type UpdateFn<T> = (snapshot: OrderSnapshot, tx: OrderTx) => Promise<{ changes?: OrderChanges; result: T }> | { changes?: OrderChanges; result: T }

export interface OrderStore {
  readonly durable: boolean
  insertOrder(order: OrderRow): Promise<void>
  findByCredentialHash(credentialHash: string): Promise<OrderSnapshot | undefined>
  update<T>(orderId: string, fn: UpdateFn<T>): Promise<T>
}

// The store could not be reached or failed mid-transaction. Nothing was committed.
export class StoreUnavailableError extends Error {
  constructor(message = 'order store unavailable', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'StoreUnavailableError'
  }
}

// A uniqueness rule refused the change (duplicate invoice, address, receipt or refund request).
export class StoreConflictError extends Error {
  constructor(message = 'order store uniqueness conflict') {
    super(message)
    this.name = 'StoreConflictError'
  }
}

// Serialises updates per order, like SELECT ... FOR UPDATE. Per process, which is exactly why this
// store is refused anywhere but a local fixture run.
export class MemoryOrderStore implements OrderStore {
  readonly durable = false
  private readonly orders = new Map<string, OrderRow>()
  private readonly byCredential = new Map<string, string>()
  private readonly invoices = new Map<string, InvoiceRow>()
  private readonly addresses = new Set<string>()
  private readonly receipts = new Map<string, ReceiptRow>()
  private readonly receiptInvoices = new Set<string>()
  private readonly refunds = new Map<string, RefundRequestRow>()
  private readonly txids = new Map<string, string>()
  private readonly locks = new Map<string, Promise<unknown>>()

  async insertOrder(order: OrderRow) {
    if (this.orders.has(order.id) || this.byCredential.has(order.credentialHash)) throw new StoreConflictError()
    this.orders.set(order.id, { ...order })
    this.byCredential.set(order.credentialHash, order.id)
  }

  async findByCredentialHash(credentialHash: string) {
    const id = this.byCredential.get(credentialHash)
    return id ? this.snapshot(id) : undefined
  }

  async update<T>(orderId: string, fn: UpdateFn<T>): Promise<T> {
    const previous = this.locks.get(orderId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(() => this.apply(orderId, fn))
    this.locks.set(orderId, run)
    try {
      return await run
    } finally {
      if (this.locks.get(orderId) === run) this.locks.delete(orderId)
    }
  }

  private snapshot(orderId: string): OrderSnapshot | undefined {
    const order = this.orders.get(orderId)
    if (!order) return undefined
    return structuredClone({
      order,
      invoices: [...this.invoices.values()].filter((i) => i.orderId === orderId).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      receipt: this.receipts.get(orderId) ?? null,
      refundRequest: this.refunds.get(orderId) ?? null,
    })
  }

  private async apply<T>(orderId: string, fn: UpdateFn<T>): Promise<T> {
    const snap = this.snapshot(orderId)
    if (!snap) throw new Error('order not found')
    // Writes from claimTxid are part of the transaction: roll them back if the decision throws.
    const claimed: string[] = []
    const tx: OrderTx = {
      claimTxid: async (txid, owner) => {
        const existing = this.txids.get(txid)
        if (existing) return existing
        this.txids.set(txid, owner)
        claimed.push(txid)
        return owner
      },
    }
    let outcome: Awaited<ReturnType<UpdateFn<T>>>
    try {
      outcome = await fn(snap, tx)
      this.validate(orderId, outcome.changes)
    } catch (error) {
      for (const txid of claimed) this.txids.delete(txid)
      throw error
    }
    this.commit(orderId, outcome.changes)
    return outcome.result
  }

  // Checks every uniqueness rule before writing anything, so a refused change leaves no partial state.
  private validate(orderId: string, changes: OrderChanges | undefined) {
    if (!changes) return
    const inv = changes.insertInvoice
    if (inv && (inv.orderId !== orderId || this.invoices.has(inv.providerInvoiceId) || this.addresses.has(inv.paymentAddress))) throw new StoreConflictError()
    for (const patch of changes.updateInvoices ?? []) {
      const existing = this.invoices.get(patch.providerInvoiceId) ?? (inv?.providerInvoiceId === patch.providerInvoiceId ? inv : undefined)
      if (!existing || existing.orderId !== orderId) throw new StoreConflictError('invoice does not belong to order')
    }
    const receipt = changes.insertReceipt
    if (receipt && (receipt.orderId !== orderId || this.receipts.has(orderId) || this.receiptInvoices.has(receipt.providerInvoiceId))) throw new StoreConflictError()
    if (changes.insertRefundRequest && this.refunds.has(orderId)) throw new StoreConflictError()
  }

  private commit(orderId: string, changes: OrderChanges | undefined) {
    if (!changes) return
    if (changes.order) this.orders.set(orderId, { ...this.orders.get(orderId)!, ...changes.order })
    if (changes.insertInvoice) {
      this.invoices.set(changes.insertInvoice.providerInvoiceId, { ...changes.insertInvoice })
      this.addresses.add(changes.insertInvoice.paymentAddress)
    }
    for (const patch of changes.updateInvoices ?? []) {
      this.invoices.set(patch.providerInvoiceId, { ...this.invoices.get(patch.providerInvoiceId)!, ...patch })
    }
    if (changes.insertReceipt) {
      this.receipts.set(orderId, { ...changes.insertReceipt })
      this.receiptInvoices.add(changes.insertReceipt.providerInvoiceId)
    }
    if (changes.revokeReceiptAt) {
      const receipt = this.receipts.get(orderId)
      if (receipt && !receipt.revokedAt) this.receipts.set(orderId, { ...receipt, revokedAt: changes.revokeReceiptAt })
    }
    if (changes.insertRefundRequest) this.refunds.set(orderId, { ...changes.insertRefundRequest })
  }
}
