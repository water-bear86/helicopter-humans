// CipherPay invoice client, pinned to cipherpay-api f6f022db1f6754b4cd74fea2275f040ec14d557b:
//   POST /api/invoices       merchant Bearer auth; response has float `price_zec`, no integer amount.
//   GET  /api/invoices/{id}  public; carries integer `price_zatoshis` and `received_zatoshis`.
// Knows nothing about orders. It returns parsed provider data or a classified failure, and never
// retries: whether a failure is safe to retry is the order service's decision.
import { looksLikeUnifiedAddress } from './address.js'

export const CIPHERPAY_ORIGIN = 'https://api.cipherpay.app'

export interface CreateInvoiceRequest {
  productName: string
  amount: number
  currency: 'USD'
}

// Field names mirror CreateInvoiceResponse in src/invoices/types.rs. No integer amount exists here.
export interface CreatedInvoice {
  invoiceId: string
  memoCode: string
  amount: number
  currency: string
  priceZec: number
  paymentAddress: string
  zcashUri: string
  expiresAt: string
}

// The public GET (src/api/invoices.rs `get`), reduced to what the checkout checks.
export interface ProviderInvoice {
  id: string
  memoCode: string
  status: string
  amount: number | null
  currency: string | null
  priceZec: number
  priceZatoshis: number
  receivedZatoshis: number
  paymentAddress: string
  zcashUri: string
  expiresAt: string
  detectedTxid: string | null
}

export type CreateOutcome =
  | { kind: 'created'; invoice: CreatedInvoice }
  // The provider answered and certainly did not create an invoice (4xx before creation).
  | { kind: 'rejected'; httpStatus: number }
  // Timeout, network error, 5xx, oversized or malformed body: an invoice may or may not exist.
  | { kind: 'unknown'; reason: string }

export type ReadOutcome =
  | { kind: 'ok'; invoice: ProviderInvoice }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string }

export interface InvoiceProvider {
  createInvoice(request: CreateInvoiceRequest, signal?: AbortSignal): Promise<CreateOutcome>
  getInvoice(invoiceId: string, signal?: AbortSignal): Promise<ReadOutcome>
}

export interface CipherPayClientOptions {
  origin: string
  apiKey: string
  fetch?: typeof fetch
  timeoutMs?: number
  maxResponseBytes?: number
  // Local fixtures only: permit an http loopback origin.
  allowLoopback?: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const MEMO = /^CP-[0-9A-F]{8}$/
const TXID = /^[0-9a-f]{64}$/
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/
const INTEGER_FIELDS = new Set(['price_zatoshis', 'received_zatoshis'])
// 400 validation, 401 bad key, 402 merchant billing past due, 403, 404, 422: all before any insert.
const REJECTED_BEFORE_CREATE = new Set([400, 401, 402, 403, 404, 422])

export function isProviderInvoiceId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

export function checkProviderOrigin(origin: string, allowLoopback = false): string {
  const url = new URL(origin)
  if (url.origin === CIPHERPAY_ORIGIN && url.pathname === '/' && !url.search) return CIPHERPAY_ORIGIN
  if (allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return url.origin
  throw new Error('provider origin is not the pinned CipherPay API')
}

class BodyTooLarge extends Error {}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLarge()
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new BodyTooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// JSON.parse, but integer fields must round-trip exactly: `9007199254740993` parses to a different
// number and is rejected instead of silently rounded.
function parseJson(text: string): Record<string, unknown> | undefined {
  let unsafe = false
  type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown
  const reviver: Reviver = (key, value, context) => {
    if (INTEGER_FIELDS.has(key) && typeof value === 'number' && context?.source !== undefined && context.source !== String(value)) unsafe = true
    return value
  }
  let parsed: unknown
  try {
    parsed = (JSON.parse as (text: string, reviver: Reviver) => unknown)(text, reviver)
  } catch {
    return undefined
  }
  if (unsafe || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

const isString = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
const isPositiveFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0
const isTimestamp = (v: unknown): v is string => typeof v === 'string' && TIMESTAMP.test(v) && Number.isFinite(Date.parse(v))
const isZatoshis = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

export function parseCreated(body: Record<string, unknown>): CreatedInvoice | undefined {
  const b = body
  if (!isProviderInvoiceId(b.invoice_id) || typeof b.memo_code !== 'string' || !MEMO.test(b.memo_code)) return undefined
  if (!isPositiveFinite(b.amount) || !isString(b.currency, 10) || !isPositiveFinite(b.price_zec)) return undefined
  if (!looksLikeUnifiedAddress(b.payment_address) || !isString(b.zcash_uri, 2048) || !isTimestamp(b.expires_at)) return undefined
  return {
    invoiceId: b.invoice_id,
    memoCode: b.memo_code,
    amount: b.amount,
    currency: b.currency,
    priceZec: b.price_zec,
    paymentAddress: b.payment_address,
    zcashUri: b.zcash_uri,
    expiresAt: b.expires_at,
  }
}

export function parseInvoice(body: Record<string, unknown>): ProviderInvoice | undefined {
  const b = body
  if (!isProviderInvoiceId(b.id) || typeof b.memo_code !== 'string' || !MEMO.test(b.memo_code) || !isString(b.status, 32)) return undefined
  if (!isPositiveFinite(b.price_zec) || !isZatoshis(b.price_zatoshis) || b.price_zatoshis === 0 || !isZatoshis(b.received_zatoshis)) return undefined
  if (!looksLikeUnifiedAddress(b.payment_address) || !isString(b.zcash_uri, 2048) || !isTimestamp(b.expires_at)) return undefined
  if (b.amount !== null && b.amount !== undefined && !isPositiveFinite(b.amount)) return undefined
  if (b.currency !== null && b.currency !== undefined && !isString(b.currency, 10)) return undefined
  if (b.detected_txid !== null && b.detected_txid !== undefined && !(typeof b.detected_txid === 'string' && TXID.test(b.detected_txid))) return undefined
  return {
    id: b.id,
    memoCode: b.memo_code,
    status: b.status,
    amount: (b.amount as number | null | undefined) ?? null,
    currency: (b.currency as string | null | undefined) ?? null,
    priceZec: b.price_zec,
    priceZatoshis: b.price_zatoshis,
    receivedZatoshis: b.received_zatoshis,
    paymentAddress: b.payment_address,
    zcashUri: b.zcash_uri,
    expiresAt: b.expires_at,
    detectedTxid: (b.detected_txid as string | null | undefined) ?? null,
  }
}

export function createCipherPayClient(options: CipherPayClientOptions): InvoiceProvider {
  const origin = checkProviderOrigin(options.origin, options.allowLoopback)
  if (!isString(options.apiKey, 512)) throw new Error('CipherPay API key is required')
  const doFetch = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? 8000
  const maxBytes = options.maxResponseBytes ?? 32 * 1024

  async function call(path: string, init: RequestInit, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await doFetch(`${origin}${path}`, {
      ...init,
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    const text = await readBounded(response, maxBytes)
    return { status: response.status, body: parseJson(text) }
  }

  return {
    async createInvoice(request, signal) {
      let res: Awaited<ReturnType<typeof call>>
      try {
        res = await call(
          '/api/invoices',
          {
            method: 'POST',
            headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
            // Server-owned values only. No refund_address: the provider's write-once address is not
            // buyer authorization, and refunds are handled through our own order credential.
            body: JSON.stringify({ product_name: request.productName, amount: request.amount, currency: request.currency }),
          },
          signal,
        )
      } catch (error) {
        return { kind: 'unknown', reason: error instanceof BodyTooLarge ? 'response_too_large' : 'network_or_timeout' }
      }
      // Only statuses upstream returns before creating anything. A proxy 408/499 or similar could
      // arrive after the invoice was created, so every other status is unknown.
      if (REJECTED_BEFORE_CREATE.has(res.status)) return { kind: 'rejected', httpStatus: res.status }
      if (res.status !== 201) return { kind: 'unknown', reason: `http_${res.status}` }
      const invoice = res.body && parseCreated(res.body)
      return invoice ? { kind: 'created', invoice } : { kind: 'unknown', reason: 'malformed_response' }
    },

    async getInvoice(invoiceId, signal) {
      if (!isProviderInvoiceId(invoiceId)) throw new RangeError('invoice id must be a provider UUID')
      let res: Awaited<ReturnType<typeof call>>
      try {
        res = await call(`/api/invoices/${invoiceId}`, { method: 'GET', headers: { accept: 'application/json' } }, signal)
      } catch (error) {
        return { kind: 'unavailable', reason: error instanceof BodyTooLarge ? 'response_too_large' : 'network_or_timeout' }
      }
      if (res.status === 404) return { kind: 'not_found' }
      if (res.status !== 200) return { kind: 'unavailable', reason: `http_${res.status}` }
      const invoice = res.body && parseInvoice(res.body)
      return invoice ? { kind: 'ok', invoice } : { kind: 'unavailable', reason: 'malformed_response' }
    },
  }
}
