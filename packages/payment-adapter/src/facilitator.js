/**
 * CipherPay x402 v2 verification client.
 *
 * This client only ever calls `POST /api/x402/v2/verify`. It does not
 * broadcast a transaction, create a wallet, request a swap, call `/settle` or
 * move funds in any direction. The buyer has already paid on the Zcash
 * network before we are asked anything; we are reading a receipt.
 *
 * Response shapes come from cipherpay-api `src/api/x402.rs`
 * (`VerifyResponseV2`, `verify_core_v2`, RFC 9457 problem details).
 */

import { SCHEME, VERIFY_PATH, X402_VERSION } from './config.js'
import { OUTCOME, REASON } from './outcomes.js'

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 10000
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_RETRY_BASE_MS = 250
export const DEFAULT_MAX_RESPONSE_BYTES = 65536

/** HTTP statuses where retrying the SAME verification may help. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * `invalidReason` values the v2 verifier emits, mapped to our outcomes.
 *
 * `invalid_transaction_state` is returned both when the transaction is not
 * yet retrievable from CipherScan AND when trial decryption errored. The
 * endpoint does not distinguish them, so we treat it as PENDING: the honest
 * reading is "cannot verify yet". A caller must bound how long it keeps
 * retrying rather than assume the payment will eventually appear.
 */
const INVALID_REASON_MAP = new Map([
  ['invalid_transaction_state', { kind: OUTCOME.PENDING, reason: REASON.TRANSACTION_NOT_VISIBLE }],
  ['insufficient_funds', { kind: OUTCOME.REJECTED, reason: REASON.INSUFFICIENT_FUNDS }],
  ['invalid_payload', { kind: OUTCOME.REJECTED, reason: REASON.NOT_ADDRESSED_TO_MERCHANT }],
])

function sleepDefault(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Read a response body with a hard byte cap, so a hostile or broken upstream
 * cannot stream us out of memory.
 */
async function readBoundedText(response, maxBytes) {
  const declared = response.headers?.get?.('content-length')
  if (declared !== null && declared !== undefined && Number(declared) > maxBytes) {
    return { ok: false, reason: 'response larger than the declared cap' }
  }

  const body = response.body
  if (body === null || body === undefined || typeof body.getReader !== 'function') {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, reason: 'response exceeded the byte cap' }
    }
    return { ok: true, text }
  }

  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return { ok: false, reason: 'response exceeded the byte cap' }
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock?.()
  }
  return { ok: true, text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') }
}

function problemType(parsed) {
  if (parsed === null || typeof parsed !== 'object') return undefined
  const type = parsed.type
  if (typeof type !== 'string') return undefined
  const slash = type.lastIndexOf('/')
  return slash === -1 ? type : type.slice(slash + 1)
}

/**
 * Build the x402 v2 verify request body.
 *
 * `paymentRequirements` and `paymentPayload.accepted` are both OUR
 * requirements. The client's copy is never forwarded: it has already been
 * compared against this challenge and discarded.
 */
export function buildVerifyRequestBody(challenge, txid) {
  const requirements = { ...challenge.requirements, extra: {} }
  return {
    x402Version: X402_VERSION,
    paymentPayload: {
      x402Version: X402_VERSION,
      resource: { ...challenge.resource },
      accepted: requirements,
      payload: { txid },
    },
    paymentRequirements: requirements,
  }
}

export class CipherPayFacilitator {
  /**
   * @param {object} args
   * @param {import('../types/index.js').AdapterConfig} args.config
   * @param {typeof fetch} [args.fetch]
   * @param {number} [args.attemptTimeoutMs]
   * @param {number} [args.maxAttempts]
   * @param {number} [args.retryBaseMs]
   * @param {number} [args.maxResponseBytes]
   * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [args.sleep]
   * @param {{ warn?: Function, error?: Function }} [args.logger]
   */
  constructor({
    config,
    fetch: fetchImpl = globalThis.fetch,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    sleep = sleepDefault,
    logger,
  }) {
    if (typeof fetchImpl !== 'function') {
      throw new TypeError('no fetch implementation available')
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new TypeError('maxAttempts must be a positive integer')
    }
    this.#config = config
    this.#fetch = fetchImpl
    this.#attemptTimeoutMs = attemptTimeoutMs
    this.#maxAttempts = maxAttempts
    this.#retryBaseMs = retryBaseMs
    this.#maxResponseBytes = maxResponseBytes
    this.#sleep = sleep
    this.#logger = logger
    this.verifyUrl = config.facilitatorUrl + VERIFY_PATH
  }

  #config
  #fetch
  #attemptTimeoutMs
  #maxAttempts
  #retryBaseMs
  #maxResponseBytes
  #sleep
  #logger

  /**
   * Verify one already-broadcast Zcash payment.
   *
   * Retries re-verify the SAME txid. Nothing here ever asks a buyer to send a
   * second transfer, and an aborted signal stops further attempts rather than
   * finishing the budget.
   *
   * @param {object} args
   * @param {import('../types/index.js').PaymentChallenge} args.challenge
   * @param {string} args.txid
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<import('../types/index.js').FacilitatorOutcome>}
   */
  async verify({ challenge, txid, signal }) {
    if (challenge.requirements.scheme !== SCHEME) {
      throw new TypeError(`unsupported scheme ${challenge.requirements.scheme}`)
    }

    const body = JSON.stringify(buildVerifyRequestBody(challenge, txid))
    let lastDetail = 'no attempt completed'

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (signal?.aborted) {
        return { kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.CANCELLED, detail: 'cancelled before attempt', operatorActionRequired: false }
      }

      const result = await this.#attempt(body, signal, attempt)
      if (result.retry !== true) return result.outcome
      lastDetail = result.outcome.detail

      if (attempt < this.#maxAttempts) {
        try {
          await this.#sleep(this.#retryBaseMs * 2 ** (attempt - 1), signal)
        } catch {
          return { kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.CANCELLED, detail: 'cancelled while backing off', operatorActionRequired: false }
        }
      }
    }

    return {
      kind: OUTCOME.UPSTREAM_ERROR,
      reason: REASON.FACILITATOR_UNAVAILABLE,
      detail: `facilitator did not answer after ${this.#maxAttempts} attempts: ${lastDetail}`,
      operatorActionRequired: false,
    }
  }

  async #attempt(body, callerSignal, attempt) {
    const timeout = AbortSignal.timeout(this.#attemptTimeoutMs)
    const signal = callerSignal === undefined ? timeout : AbortSignal.any([callerSignal, timeout])

    let response
    try {
      response = await this.#fetch(this.verifyUrl, {
        method: 'POST',
        headers: {
          // The only place the merchant key appears. Never logged, never
          // echoed into an outcome, never returned to a caller.
          authorization: `Bearer ${this.#config.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, application/problem+json',
        },
        body,
        signal,
        redirect: 'error',
      })
    } catch (error) {
      if (callerSignal?.aborted === true) {
        return {
          retry: false,
          outcome: { kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.CANCELLED, detail: 'verification cancelled by caller', operatorActionRequired: false },
        }
      }
      if (timeout.aborted === true) {
        this.#logger?.warn?.({ event: 'facilitator_timeout', attempt })
        return {
          retry: true,
          outcome: { kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.FACILITATOR_TIMEOUT, detail: `attempt ${attempt} timed out after ${this.#attemptTimeoutMs}ms`, operatorActionRequired: false },
        }
      }
      this.#logger?.warn?.({ event: 'facilitator_transport_error', attempt })
      return {
        retry: true,
        outcome: { kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.FACILITATOR_UNAVAILABLE, detail: `attempt ${attempt} transport error: ${error?.name ?? 'Error'}`, operatorActionRequired: false },
      }
    }

    const read = await readBoundedText(response, this.#maxResponseBytes)
    if (!read.ok) {
      return {
        retry: false,
        outcome: { kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.FACILITATOR_BAD_RESPONSE, detail: read.reason, operatorActionRequired: true },
      }
    }

    let parsed
    try {
      parsed = read.text === '' ? undefined : JSON.parse(read.text)
    } catch {
      parsed = undefined
    }

    return this.#classify(response.status, parsed, attempt)
  }

  #classify(status, parsed, attempt) {
    if (status === 401) {
      this.#logger?.error?.({ event: 'facilitator_unauthorized', attempt })
      return {
        retry: false,
        outcome: {
          kind: OUTCOME.UPSTREAM_ERROR,
          reason: REASON.MERCHANT_UNAUTHORIZED,
          // OUR key, not the buyer's payment. A route must not tell a buyer
          // their payment failed because of this.
          detail: 'the facilitator rejected our merchant API key',
          operatorActionRequired: true,
        },
      }
    }

    if (status === 402) {
      this.#logger?.error?.({ event: 'facilitator_billing_blocked', attempt })
      return {
        retry: false,
        outcome: {
          kind: OUTCOME.UPSTREAM_ERROR,
          reason: REASON.MERCHANT_BILLING_BLOCKED,
          detail: 'our CipherPay merchant account has outstanding fees; the buyer payment was not assessed',
          operatorActionRequired: true,
        },
      }
    }

    if (status === 400) {
      return {
        retry: false,
        outcome: {
          kind: OUTCOME.UPSTREAM_ERROR,
          reason: REASON.FACILITATOR_BAD_RESPONSE,
          detail: `the facilitator rejected our request body (${problemType(parsed) ?? 'invalid-request'})`,
          operatorActionRequired: true,
        },
      }
    }

    if (RETRYABLE_STATUS.has(status)) {
      return {
        retry: true,
        outcome: {
          kind: OUTCOME.UPSTREAM_ERROR,
          reason: REASON.FACILITATOR_UNAVAILABLE,
          detail: `attempt ${attempt} got HTTP ${status}`,
          operatorActionRequired: false,
        },
      }
    }

    if (status !== 200) {
      return {
        retry: false,
        outcome: {
          kind: OUTCOME.UPSTREAM_ERROR,
          reason: REASON.FACILITATOR_BAD_RESPONSE,
          detail: `unexpected HTTP ${status} from the facilitator`,
          operatorActionRequired: true,
        },
      }
    }

    if (parsed === null || typeof parsed !== 'object' || typeof parsed.isValid !== 'boolean') {
      return {
        retry: false,
        outcome: {
          kind: OUTCOME.UPSTREAM_ERROR,
          reason: REASON.FACILITATOR_BAD_RESPONSE,
          detail: 'verify response did not contain a boolean isValid',
          operatorActionRequired: true,
        },
      }
    }

    if (parsed.isValid === true) {
      // The v2 verify response carries no received amount, so there is
      // nothing to re-check here. See README.md, "Amount enforcement".
      return { retry: false, outcome: { kind: OUTCOME.VERIFIED } }
    }

    const mapped = INVALID_REASON_MAP.get(parsed.invalidReason)
    if (mapped === undefined) {
      return {
        retry: false,
        outcome: {
          kind: OUTCOME.REJECTED,
          reason: REASON.FACILITATOR_REJECTED,
          detail: `facilitator reported the payment invalid (${typeof parsed.invalidReason === 'string' ? parsed.invalidReason : 'no reason given'})`,
          operatorActionRequired: false,
        },
      }
    }

    return {
      retry: false,
      outcome: {
        kind: mapped.kind,
        reason: mapped.reason,
        detail:
          mapped.kind === OUTCOME.PENDING
            ? 'the facilitator cannot see this transaction yet'
            : 'the facilitator did not accept this payment for these requirements',
        operatorActionRequired: false,
      },
    }
  }
}
