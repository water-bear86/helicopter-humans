/**
 * Receipt ledger contract.
 *
 * The facilitator does not solve replay for us. cipherpay-api's
 * `verify_core_v2` returns `isValid: true` for an already-verified txid
 * whenever the stored amount still covers the quote, and `@cipherpay/x402`
 * does not apply `rejectReplays` on the v2 path. So: one txid grants exactly
 * one request, and WE are the ones who remember that.
 *
 * The ledger is injected. This module defines the contract and ships one
 * in-memory implementation that is for tests and local development only.
 */

import { createHash } from 'node:crypto'
import { LedgerContractError } from './errors.js'

/** Claim states a ledger record can hold. */
export const RECORD_STATE = Object.freeze({
  /** Reserved by a request that has not reached a terminal outcome yet. */
  CLAIMED: 'claimed',
  /** Verified and granted to the owning request. */
  GRANTED: 'granted',
  /** Verification came back negative for the owning request. */
  REJECTED: 'rejected',
})

/** Result of a `claim` call. */
export const CLAIM = Object.freeze({
  /** First claimant. Proceed to verify. */
  ACQUIRED: 'acquired',
  /** Same request, same price, same resource. Reuse a terminal stored outcome. */
  OWNED: 'owned',
  /**
   * Someone else's payment, a different price tier, or the same request now
   * asking for a different resource. Grant nothing.
   */
  TAKEN: 'taken',
})

/**
 * Non-reversible merchant scope for ledger keys, so the ledger never stores
 * the API key itself.
 *
 * Consequence to plan for: rotating `CIPHERPAY_API_KEY` changes this scope,
 * and old records stop matching. Pass an explicit `merchantId` to the adapter
 * if you rotate keys and want replay protection to survive a rotation.
 *
 * @param {string} apiKey
 * @returns {string}
 */
export function merchantScopeFromApiKey(apiKey) {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 32)
}

/**
 * Canonical ledger key. Lower-cased txid: see `parsePaymentSignature`.
 *
 * The resource is deliberately NOT part of the key: one txid must grant exactly
 * one resource, so a second resource has to collide with the first record and
 * lose, not open a second row.
 *
 * @param {{ network: string, merchantId: string, txid: string }} args
 * @returns {string}
 */
export function receiptKey({ network, merchantId, txid }) {
  return `${network}|${merchantId}|${txid.toLowerCase()}`
}

const REQUIRED_METHODS = ['claim', 'settle', 'get']

/**
 * Validate an injected ledger against the contract.
 *
 * @param {unknown} ledger
 * @returns {import('../types/index.js').ReceiptLedger}
 */
export function assertReceiptLedger(ledger) {
  if (ledger === null || typeof ledger !== 'object') {
    throw new LedgerContractError('a receipt ledger is required')
  }
  for (const method of REQUIRED_METHODS) {
    if (typeof ledger[method] !== 'function') {
      throw new LedgerContractError(`receipt ledger is missing ${method}()`)
    }
  }
  if (typeof ledger.durable !== 'boolean') {
    throw new LedgerContractError(
      'receipt ledger must declare `durable: boolean` so the adapter can fail closed',
    )
  }
  return /** @type {import('../types/index.js').ReceiptLedger} */ (ledger)
}

/**
 * In-memory receipt ledger. **Tests and local development only.**
 *
 * `durable: false`, which makes the adapter refuse to run in live mode
 * without an explicit override. Two processes -- two serverless instances,
 * two regions, a deploy overlapping the previous one -- each hold their own
 * copy of this Map and would each grant a resource for the same txid.
 *
 * Atomicity here comes from doing the read and the write in one synchronous
 * run of the event loop, before any `await`. A durable implementation must
 * get the same property from the storage engine: a single conditional insert
 * (`INSERT ... ON CONFLICT DO NOTHING` and inspect the row count), not a
 * SELECT followed by an INSERT.
 */
export class InMemoryReceiptLedger {
  /** @param {{ now?: () => number }} [options] */
  constructor(options = {}) {
    this.durable = false
    this.#now = options.now ?? Date.now
  }

  /** @type {Map<string, import('../types/index.js').ReceiptRecord>} */
  #records = new Map()
  #now

  /**
   * Reserve a txid for one request, atomically.
   *
   * `resource` is stored and compared, not just carried: one txid grants one
   * request AND one resource. Without it, a request id reused across two
   * resources replays a single payment into both.
   *
   * @param {import('../types/index.js').ClaimRequest} claim
   * @returns {Promise<import('../types/index.js').ClaimResult>}
   */
  async claim({ network, merchantId, txid, requestId, amountZatoshis, resource }) {
    if (typeof resource !== 'string' || resource === '') {
      throw new LedgerContractError('claim requires the resource this payment is buying')
    }
    const key = receiptKey({ network, merchantId, txid })
    const existing = this.#records.get(key)

    if (existing === undefined) {
      const timestamp = new Date(this.#now()).toISOString()
      const record = {
        network,
        merchantId,
        txid: txid.toLowerCase(),
        requestId,
        amountZatoshis: String(amountZatoshis),
        resource,
        state: RECORD_STATE.CLAIMED,
        outcome: undefined,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      this.#records.set(key, record)
      return { status: CLAIM.ACQUIRED, record: { ...record } }
    }

    // Same request AND same price tier AND same resource is a retry. Anything
    // else -- another request id, the same request re-priced, or the same
    // request pointed at a different resource -- gets nothing.
    if (
      existing.requestId === requestId &&
      existing.amountZatoshis === String(amountZatoshis) &&
      existing.resource === resource
    ) {
      return { status: CLAIM.OWNED, record: { ...existing } }
    }

    return { status: CLAIM.TAKEN, record: { ...existing } }
  }

  /**
   * Record the terminal outcome for a claim. Only the owning request may.
   *
   * @param {import('../types/index.js').SettleRequest} settlement
   * @returns {Promise<import('../types/index.js').ReceiptRecord>}
   */
  async settle({ network, merchantId, txid, requestId, state, outcome }) {
    const key = receiptKey({ network, merchantId, txid })
    const existing = this.#records.get(key)
    if (existing === undefined) {
      throw new LedgerContractError(`cannot settle an unclaimed receipt ${key}`)
    }
    if (existing.requestId !== requestId) {
      throw new LedgerContractError(`request ${requestId} does not own receipt ${key}`)
    }
    const updated = {
      ...existing,
      state,
      outcome,
      updatedAt: new Date(this.#now()).toISOString(),
    }
    this.#records.set(key, updated)
    return { ...updated }
  }

  /**
   * @param {{ network: string, merchantId: string, txid: string }} args
   * @returns {Promise<import('../types/index.js').ReceiptRecord | undefined>}
   */
  async get({ network, merchantId, txid }) {
    const record = this.#records.get(receiptKey({ network, merchantId, txid }))
    return record === undefined ? undefined : { ...record }
  }

  /** Test helper. Not part of the contract. */
  size() {
    return this.#records.size
  }
}
