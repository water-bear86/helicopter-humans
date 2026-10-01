// Durable OrderStore on PostgreSQL (schema: db/migrations/0001_checkout_orders.sql). Safe across any
// number of function instances: each update runs in one transaction holding the order row lock, and
// unique constraints back up every "exactly once" rule in case application logic is ever wrong.
// Network calls to the provider never happen inside a transaction.
import pg from 'pg'
import {
  StoreConflictError,
  StoreUnavailableError,
  type InvoiceRow,
  type OrderChanges,
  type OrderRow,
  type OrderSnapshot,
  type OrderStore,
  type OrderTx,
  type ReceiptRow,
  type RefundRequestRow,
  type UpdateFn,
} from './store.js'

type Queryable = Pick<pg.PoolClient, 'query'>

export interface PostgresStoreOptions {
  connectionString: string
  // Serverless functions each hold their own pool; keep it small and point it at a pooler.
  maxConnections?: number
  statementTimeoutMs?: number
}

// Refuses plaintext connections to anything but a loopback test database.
export function checkConnectionString(connectionString: string): void {
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    throw new Error('CHECKOUT_DATABASE_URL is not a valid URL')
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error('CHECKOUT_DATABASE_URL must be a postgres URL')
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const sslmode = url.searchParams.get('sslmode')
  if (!loopback && sslmode !== 'require' && sslmode !== 'verify-full') throw new Error('CHECKOUT_DATABASE_URL must set sslmode=require or verify-full')
}

const toIso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString())
const toIsoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : toIso(v))
function toSafeInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isSafeInteger(n)) throw new StoreConflictError('stored integer out of safe range')
  return n
}
const toSafeIntOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : toSafeInt(v))

function orderFromRow(r: Record<string, unknown>): OrderRow {
  return {
    id: String(r.id),
    credentialHash: String(r.credential_hash),
    offerId: String(r.offer_id),
    offerVersion: String(r.offer_version),
    fiatCurrency: 'USD',
    fiatAmountCents: toSafeInt(r.fiat_amount_cents),
    state: r.state as OrderRow['state'],
    stateReason: (r.state_reason as string | null) ?? null,
    activeInvoiceId: (r.active_invoice_id as string | null) ?? null,
    quoteCount: toSafeInt(r.quote_count),
    claimToken: (r.claim_token as string | null) ?? null,
    claimExpiresAt: toIsoOrNull(r.claim_expires_at),
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

function invoiceFromRow(r: Record<string, unknown>): InvoiceRow {
  return {
    providerInvoiceId: String(r.provider_invoice_id),
    orderId: String(r.order_id),
    memoCode: String(r.memo_code),
    paymentAddress: String(r.payment_address),
    priceZec: Number(r.price_zec),
    priceZatoshis: toSafeIntOrNull(r.price_zatoshis),
    paymentUri: (r.payment_uri as string | null) ?? null,
    quoteExpiresAt: toIso(r.quote_expires_at),
    providerExpiresAt: toIso(r.provider_expires_at),
    detectedAt: toIsoOrNull(r.detected_at),
    confirmedAt: toIsoOrNull(r.confirmed_at),
    providerStatus: String(r.provider_status),
    receivedZatoshis: toSafeInt(r.received_zatoshis),
    rejectedReason: (r.rejected_reason as string | null) ?? null,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  }
}

function receiptFromRow(r: Record<string, unknown>): ReceiptRow {
  return {
    id: String(r.id),
    orderId: String(r.order_id),
    providerInvoiceId: String(r.provider_invoice_id),
    offerId: String(r.offer_id),
    offerVersion: String(r.offer_version),
    fiatAmountCents: toSafeInt(r.fiat_amount_cents),
    priceZatoshis: toSafeInt(r.price_zatoshis),
    receivedZatoshis: toSafeInt(r.received_zatoshis),
    createdAt: toIso(r.created_at),
    revokedAt: toIsoOrNull(r.revoked_at),
  }
}

function refundFromRow(r: Record<string, unknown>): RefundRequestRow {
  return {
    id: String(r.id),
    orderId: String(r.order_id),
    refundAddress: String(r.refund_address),
    receivedZatoshis: toSafeInt(r.received_zatoshis),
    createdAt: toIso(r.created_at),
  }
}

// camelCase field -> column, for the order fields an update may set.
const ORDER_COLUMNS: Record<string, string> = {
  state: 'state',
  stateReason: 'state_reason',
  activeInvoiceId: 'active_invoice_id',
  quoteCount: 'quote_count',
  claimToken: 'claim_token',
  claimExpiresAt: 'claim_expires_at',
  updatedAt: 'updated_at',
}
const INVOICE_COLUMNS: Record<string, string> = {
  priceZatoshis: 'price_zatoshis',
  paymentUri: 'payment_uri',
  providerStatus: 'provider_status',
  receivedZatoshis: 'received_zatoshis',
  rejectedReason: 'rejected_reason',
  providerExpiresAt: 'provider_expires_at',
  detectedAt: 'detected_at',
  confirmedAt: 'confirmed_at',
  updatedAt: 'updated_at',
}

function setClause(patch: Record<string, unknown>, columns: Record<string, string>, first: number) {
  const sets: string[] = []
  const values: unknown[] = []
  for (const [key, value] of Object.entries(patch)) {
    const column = columns[key]
    if (!column) continue
    values.push(value)
    sets.push(`${column} = $${first + values.length - 1}`)
  }
  return { sets, values }
}

// Database and driver failures only. Constraint and serialization failures are conflicts: nothing was
// committed and the uniqueness rule held. Everything else (connection, timeout, server) is unavailability.
function dbError(error: unknown): Error {
  if (error instanceof StoreConflictError || error instanceof StoreUnavailableError) return error
  const code = (error as { code?: unknown })?.code
  if (typeof code === 'string' && (code.startsWith('23') || code === '40001' || code === '40P01')) return new StoreConflictError(`constraint ${code}`)
  return new StoreUnavailableError('order store unavailable', { cause: error })
}

export class PostgresOrderStore implements OrderStore {
  readonly durable = true
  private readonly pool: pg.Pool

  constructor(options: PostgresStoreOptions | { pool: pg.Pool }) {
    if ('pool' in options) {
      this.pool = options.pool
      return
    }
    checkConnectionString(options.connectionString)
    const statementTimeout = options.statementTimeoutMs ?? 5000
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 3,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10_000,
      statement_timeout: statementTimeout,
      query_timeout: statementTimeout + 1000,
      application_name: 'helicopter-humans-checkout',
    })
    // An idle client error must not crash the function; the next query reports it.
    this.pool.on('error', () => undefined)
  }

  async close() {
    await this.pool.end()
  }

  async insertOrder(o: OrderRow) {
    try {
      await this.pool.query(
        `INSERT INTO checkout_orders (id, credential_hash, offer_id, offer_version, fiat_currency, fiat_amount_cents, state, state_reason,
           active_invoice_id, quote_count, claim_token, claim_expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [o.id, o.credentialHash, o.offerId, o.offerVersion, o.fiatCurrency, o.fiatAmountCents, o.state, o.stateReason,
          o.activeInvoiceId, o.quoteCount, o.claimToken, o.claimExpiresAt, o.createdAt, o.updatedAt],
      )
    } catch (error) {
      throw dbError(error)
    }
  }

  async findByCredentialHash(credentialHash: string): Promise<OrderSnapshot | undefined> {
    try {
      const { rows } = await this.pool.query('SELECT * FROM checkout_orders WHERE credential_hash = $1', [credentialHash])
      if (!rows[0]) return undefined
      return await this.loadRest(this.pool, orderFromRow(rows[0]))
    } catch (error) {
      throw dbError(error)
    }
  }

  private async loadRest(db: Queryable, order: OrderRow): Promise<OrderSnapshot> {
    // Sequential: overlapping queries on one client are deprecated in pg 8 and rejected by pg 9.
    const invoices = await db.query(
      'SELECT * FROM checkout_invoices WHERE order_id = $1 ORDER BY created_at, provider_invoice_id',
      [order.id],
    )
    const receipts = await db.query('SELECT * FROM checkout_receipts WHERE order_id = $1', [order.id])
    const refunds = await db.query('SELECT * FROM checkout_refund_requests WHERE order_id = $1', [order.id])
    return {
      order,
      invoices: invoices.rows.map(invoiceFromRow),
      receipt: receipts.rows[0] ? receiptFromRow(receipts.rows[0]) : null,
      refundRequest: refunds.rows[0] ? refundFromRow(refunds.rows[0]) : null,
    }
  }

  async update<T>(orderId: string, fn: UpdateFn<T>): Promise<T> {
    let client: pg.PoolClient
    try {
      client = await this.pool.connect()
    } catch (error) {
      throw new StoreUnavailableError('order store unavailable', { cause: error })
    }
    let broken = false
    // Errors raised by the caller's decision are passed through untouched; database errors are mapped.
    let decisionError: { error: unknown } | undefined
    try {
      await client.query('BEGIN')
      const { rows } = await client.query('SELECT * FROM checkout_orders WHERE id = $1 FOR UPDATE', [orderId])
      if (!rows[0]) throw new StoreConflictError('order not found')
      const snapshot = await this.loadRest(client, orderFromRow(rows[0]))
      const tx: OrderTx = {
        claimTxid: async (txid, owner, invoiceId, now) => {
          try {
            await client.query(
              'INSERT INTO checkout_payment_txids (txid, order_id, provider_invoice_id, first_seen_at) VALUES ($1,$2,$3,$4) ON CONFLICT (txid) DO NOTHING',
              [txid, owner, invoiceId, now],
            )
            const found = await client.query('SELECT order_id FROM checkout_payment_txids WHERE txid = $1', [txid])
            return String(found.rows[0].order_id)
          } catch (error) {
            throw dbError(error)
          }
        },
      }
      let outcome: Awaited<ReturnType<UpdateFn<T>>>
      try {
        outcome = await fn(snapshot, tx)
      } catch (error) {
        decisionError = { error }
        throw error
      }
      await this.apply(client, orderId, outcome.changes)
      await client.query('COMMIT')
      return outcome.result
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        broken = true
      }
      throw decisionError?.error === error ? error : dbError(error)
    } finally {
      client.release(broken)
    }
  }

  private async apply(db: Queryable, orderId: string, changes: OrderChanges | undefined) {
    if (!changes) return
    const inv = changes.insertInvoice
    if (inv) {
      if (inv.orderId !== orderId) throw new StoreConflictError('invoice does not belong to order')
      await db.query(
        `INSERT INTO checkout_invoices (provider_invoice_id, order_id, memo_code, payment_address, price_zec, price_zatoshis, payment_uri,
           quote_expires_at, provider_expires_at, detected_at, confirmed_at, provider_status, received_zatoshis, rejected_reason, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [inv.providerInvoiceId, inv.orderId, inv.memoCode, inv.paymentAddress, inv.priceZec, inv.priceZatoshis, inv.paymentUri,
          inv.quoteExpiresAt, inv.providerExpiresAt, inv.detectedAt, inv.confirmedAt, inv.providerStatus, inv.receivedZatoshis, inv.rejectedReason, inv.createdAt, inv.updatedAt],
      )
    }
    for (const patch of changes.updateInvoices ?? []) {
      const { sets, values } = setClause(patch, INVOICE_COLUMNS, 3)
      if (!sets.length) continue
      const res = await db.query(`UPDATE checkout_invoices SET ${sets.join(', ')} WHERE provider_invoice_id = $1 AND order_id = $2`, [
        patch.providerInvoiceId,
        orderId,
        ...values,
      ])
      if (res.rowCount !== 1) throw new StoreConflictError('invoice does not belong to order')
    }
    if (changes.order) {
      const { sets, values } = setClause(changes.order, ORDER_COLUMNS, 2)
      if (sets.length) await db.query(`UPDATE checkout_orders SET ${sets.join(', ')} WHERE id = $1`, [orderId, ...values])
    }
    const r = changes.insertReceipt
    if (r) {
      if (r.orderId !== orderId) throw new StoreConflictError('receipt does not belong to order')
      await db.query(
        `INSERT INTO checkout_receipts (id, order_id, provider_invoice_id, offer_id, offer_version, fiat_amount_cents, price_zatoshis,
           received_zatoshis, created_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [r.id, r.orderId, r.providerInvoiceId, r.offerId, r.offerVersion, r.fiatAmountCents, r.priceZatoshis, r.receivedZatoshis, r.createdAt, r.revokedAt],
      )
    }
    if (changes.revokeReceiptAt) {
      await db.query('UPDATE checkout_receipts SET revoked_at = $2 WHERE order_id = $1 AND revoked_at IS NULL', [orderId, changes.revokeReceiptAt])
    }
    const f = changes.insertRefundRequest
    if (f) {
      await db.query(
        'INSERT INTO checkout_refund_requests (id, order_id, refund_address, received_zatoshis, created_at) VALUES ($1,$2,$3,$4,$5)',
        [f.id, orderId, f.refundAddress, f.receivedZatoshis, f.createdAt],
      )
    }
  }
}
