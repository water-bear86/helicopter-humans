/**
 * Server-owned payment challenges.
 *
 * The requirements in a challenge are built from configuration only. Nothing
 * a client sends can lower the price, change the destination or switch the
 * network -- a client's envelope is only ever compared against a challenge we
 * created, never used in its place.
 */

import { randomUUID } from 'node:crypto'
import { ASSET, SCHEME, X402_VERSION } from './config.js'
import { challengeClaims } from './quote-signing.js'

/** Challenge lifetime, matching the CipherPay middleware default of 300s. */
export const DEFAULT_QUOTE_TTL_SECONDS = 300

/** Per the Zcash `exact` scheme proposal's example requirements. */
export const DEFAULT_MAX_TIMEOUT_SECONDS = 120

function assertResource(resource) {
  if (resource === null || typeof resource !== 'object') {
    throw new TypeError('resource must be an object with a url')
  }
  if (typeof resource.url !== 'string' || resource.url === '') {
    throw new TypeError('resource.url must be a non-empty string')
  }
}

/**
 * Create an expiring, server-owned challenge for one resource.
 *
 * The returned `quoteId` is `<nonce>.<mac>`: `signQuoteId` seals every field
 * this function put in the challenge, so `settle` can tell a quote we issued
 * from one a caller assembled or edited. Treat it as opaque.
 *
 * The mac is NOT payer binding and does NOT bind a payer to this challenge:
 * the v2 verify endpoint has no challenge, memo or caller binding, so
 * possession of a txid is all the facilitator ever checks. See README.md,
 * "Payer binding".
 *
 * @param {object} args
 * @param {import('../types/index.js').AdapterConfig} args.config
 * @param {{ url: string, description?: string, mimeType?: string }} args.resource
 * @param {(nonce: string, claims: string) => string} args.signQuoteId
 * @param {string|null} [args.productId] set when the challenge came from `quote()`
 * @param {string} [args.quoteId] the nonce to use; a mac is appended to it
 * @param {number} [args.ttlSeconds]
 * @param {number} [args.maxTimeoutSeconds]
 * @param {() => number} [args.now]
 * @returns {import('../types/index.js').PaymentChallenge}
 */
export function createPaymentChallenge({
  config,
  resource,
  signQuoteId,
  productId = null,
  quoteId = randomUUID(),
  ttlSeconds = DEFAULT_QUOTE_TTL_SECONDS,
  maxTimeoutSeconds = DEFAULT_MAX_TIMEOUT_SECONDS,
  now = Date.now,
}) {
  assertResource(resource)
  if (typeof signQuoteId !== 'function') {
    throw new TypeError('signQuoteId is required: an unsigned quote cannot be settled')
  }
  if (productId !== null && (typeof productId !== 'string' || productId === '')) {
    throw new TypeError('productId must be a non-empty string or null')
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('ttlSeconds must be a positive integer')
  }
  if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
    throw new TypeError('maxTimeoutSeconds must be a positive integer')
  }

  const createdAtMs = now()
  const expiresAtMs = createdAtMs + ttlSeconds * 1000

  const unsigned = {
    quoteId,
    productId,
    x402Version: X402_VERSION,
    resource: Object.freeze({
      url: resource.url,
      description: resource.description ?? '',
      mimeType: resource.mimeType ?? 'application/json',
    }),
    requirements: Object.freeze({
      scheme: SCHEME,
      network: config.network,
      asset: ASSET,
      // Integer zatoshis as a decimal string. The facilitator parses this
      // into a u64; a float here would be rejected outright.
      amount: config.priceZatoshis.toString(),
      payTo: config.payTo,
      maxTimeoutSeconds,
      extra: Object.freeze({}),
    }),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
  }

  // The mac covers the challenge as built above, so it must be computed last.
  return Object.freeze({ ...unsigned, quoteId: signQuoteId(quoteId, challengeClaims(unsigned)) })
}

/**
 * @param {import('../types/index.js').PaymentChallenge} challenge
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isChallengeExpired(challenge, nowMs = Date.now()) {
  return nowMs >= Date.parse(challenge.expiresAt)
}

/**
 * The x402 v2 `PaymentRequired` object: the 402 response body, and the same
 * object base64-encoded in the `PAYMENT-REQUIRED` header.
 *
 * @param {import('../types/index.js').PaymentChallenge} challenge
 */
export function paymentRequiredBody(challenge) {
  return {
    x402Version: challenge.x402Version,
    resource: { ...challenge.resource },
    accepts: [{ ...challenge.requirements, extra: {} }],
  }
}

/**
 * @param {import('../types/index.js').PaymentChallenge} challenge
 * @returns {string} base64 of the `PaymentRequired` JSON
 */
export function encodePaymentRequiredHeader(challenge) {
  return Buffer.from(JSON.stringify(paymentRequiredBody(challenge)), 'utf8').toString('base64')
}

/**
 * The `PAYMENT-RESPONSE` header value for a verified payment. Zcash
 * settlement is client-driven, so this is a verification confirmation and not
 * a settlement receipt: no funds moved as a result of our request.
 *
 * @param {{ txid: string, network: string }} args
 * @returns {string}
 */
export function encodePaymentResponseHeader({ txid, network }) {
  return Buffer.from(JSON.stringify({ success: true, txid, network }), 'utf8').toString('base64')
}
