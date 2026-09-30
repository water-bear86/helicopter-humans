/**
 * Quote signing.
 *
 * The problem this solves: `settle(quote, proof)` receives the quote back from
 * the caller, and a serverless deployment has nowhere to remember the quotes it
 * issued. Without a check, a caller can hand us a quote we never issued, or one
 * we issued with `expiresAt` or `productId` rewritten, and it would look exactly
 * like ours because every money field still matches configuration.
 *
 * So the quote id IS the signature. `quoteId` is `<nonce>.<mac>`, where the mac
 * covers every field the server owns: the product, the resource, the scheme,
 * the network, the asset, the amount, the destination, the timeout and the
 * expiry. Change any of them and the mac stops matching. This keeps the site's
 * `Quote` shape byte-identical -- no new field for a consumer to drop.
 *
 * What this is NOT: payer binding. The mac proves WE issued these terms; it
 * says nothing about who paid. Anyone holding a txid can still present it. See
 * `INTEGRATION_BLOCKERS.no_payer_binding`.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/** Separator between nonce and mac. Parsed with `lastIndexOf`, so a nonce may contain it. */
const SEPARATOR = '.'

/** Domain separation, so the signing secret is not reusable elsewhere. */
const DERIVATION_LABEL = 'helicopter-humans/payment-adapter/quote-signing/v1'

/**
 * Derive a quote-signing secret from the merchant API key.
 *
 * Consequence to plan for: rotating `CIPHERPAY_API_KEY` invalidates every
 * quote still in flight. With a 300s TTL that is a small window of failed
 * settles, and they fail closed. Pass an explicit `quoteSigningSecret` to the
 * adapter if you would rather quotes survive a key rotation.
 *
 * @param {string} apiKey
 * @returns {Buffer}
 */
export function deriveQuoteSigningSecret(apiKey) {
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new TypeError('deriveQuoteSigningSecret needs a non-empty api key')
  }
  return createHmac('sha256', apiKey).update(DERIVATION_LABEL, 'utf8').digest()
}

/**
 * Canonicalise the signed claims. Each field is length-prefixed so that no
 * combination of values can be re-split into a different one -- otherwise a
 * product named `a|b` could borrow the next field's meaning.
 *
 * @param {string[]} fields
 * @returns {string}
 */
function canonicalise(fields) {
  return fields.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|')
}

/**
 * The server-owned claims of a challenge, in a fixed order.
 *
 * Deliberately excluded: `createdAt`, because the site's `Quote` shape does not
 * carry it and `settle` could not reproduce it. Nothing decides anything on
 * `createdAt` -- expiry is read from `expiresAt`.
 *
 * @param {import('../types/index.js').PaymentChallenge} challenge
 * @returns {string}
 */
export function challengeClaims(challenge) {
  const requirements = challenge?.requirements ?? {}
  return canonicalise([
    challenge?.productId ?? '',
    challenge?.resource?.url ?? '',
    String(requirements.scheme ?? ''),
    String(requirements.network ?? ''),
    String(requirements.asset ?? ''),
    String(requirements.amount ?? ''),
    String(requirements.payTo ?? ''),
    String(requirements.maxTimeoutSeconds ?? ''),
    String(challenge?.expiresAt ?? ''),
  ])
}

/**
 * @param {Buffer|string} secret
 * @param {string} nonce
 * @param {string} claims
 * @returns {string} base64url mac
 */
function mac(secret, nonce, claims) {
  return createHmac('sha256', secret)
    .update(canonicalise([nonce, claims]), 'utf8')
    .digest('base64url')
}

/**
 * A signer for quote ids.
 *
 * @param {{ secret: Buffer|string }} options
 */
export function createQuoteSigner({ secret }) {
  if (!(typeof secret === 'string' ? secret.length > 0 : Buffer.isBuffer(secret) && secret.length > 0)) {
    throw new TypeError('createQuoteSigner needs a non-empty secret')
  }

  return Object.freeze({
    /**
     * @param {string} nonce
     * @param {string} claims from `challengeClaims`
     * @returns {string} the quote id to publish
     */
    issue(nonce, claims) {
      if (typeof nonce !== 'string' || nonce === '') {
        throw new TypeError('quote nonce must be a non-empty string')
      }
      return `${nonce}${SEPARATOR}${mac(secret, nonce, claims)}`
    },

    /**
     * Does this quote id carry our mac over exactly these claims?
     *
     * @param {unknown} quoteId
     * @param {string} claims from `challengeClaims`
     * @returns {boolean}
     */
    verify(quoteId, claims) {
      if (typeof quoteId !== 'string') return false
      const split = quoteId.lastIndexOf(SEPARATOR)
      if (split <= 0 || split === quoteId.length - 1) return false

      const nonce = quoteId.slice(0, split)
      const presented = Buffer.from(quoteId.slice(split + 1), 'utf8')
      const expected = Buffer.from(mac(secret, nonce, claims), 'utf8')
      // Length differs => not ours. `timingSafeEqual` throws on length mismatch.
      if (presented.length !== expected.length) return false
      return timingSafeEqual(presented, expected)
    },
  })
}
