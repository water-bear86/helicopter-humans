/**
 * `PAYMENT-SIGNATURE` envelope parsing and challenge matching.
 *
 * Everything here is bounded: a header we refuse to read is cheaper than a
 * header that exhausts memory. Nothing from the envelope reaches the
 * facilitator -- we send our own challenge's requirements and only the txid
 * comes from the client.
 */

import { parseZatoshis } from './amounts.js'
import { X402_VERSION } from './config.js'
import { isChallengeExpired } from './challenge.js'
import { REASON } from './outcomes.js'

/** Generous for a ~400 byte envelope, far below any proxy header limit. */
export const DEFAULT_MAX_HEADER_BYTES = 8192

/** Decoded JSON bound, applied before `JSON.parse` sees the string. */
export const DEFAULT_MAX_ENVELOPE_BYTES = 8192

const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/
const TXID = /^[0-9a-fA-F]{64}$/

function fail(reason, detail) {
  return { ok: false, reason, detail }
}

/**
 * Decode and structurally validate a `PAYMENT-SIGNATURE` header value.
 *
 * @param {unknown} headerValue
 * @param {{ maxHeaderBytes?: number, maxEnvelopeBytes?: number }} [limits]
 * @returns {import('../types/index.js').EnvelopeParseResult}
 */
export function parsePaymentSignature(headerValue, limits = {}) {
  const maxHeaderBytes = limits.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES
  const maxEnvelopeBytes = limits.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES

  if (headerValue === undefined || headerValue === null || headerValue === '') {
    return fail(REASON.MISSING_PAYMENT_HEADER, 'no PAYMENT-SIGNATURE header')
  }
  if (typeof headerValue !== 'string') {
    return fail(REASON.MALFORMED_PAYMENT_HEADER, 'PAYMENT-SIGNATURE must be a single string value')
  }
  if (Buffer.byteLength(headerValue, 'utf8') > maxHeaderBytes) {
    return fail(REASON.HEADER_TOO_LARGE, `PAYMENT-SIGNATURE exceeds ${maxHeaderBytes} bytes`)
  }

  const encoded = headerValue.trim()
  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
    return fail(REASON.MALFORMED_PAYMENT_HEADER, 'PAYMENT-SIGNATURE is not valid base64')
  }

  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.byteLength === 0) {
    return fail(REASON.MALFORMED_PAYMENT_HEADER, 'PAYMENT-SIGNATURE decoded to nothing')
  }
  if (decoded.byteLength > maxEnvelopeBytes) {
    return fail(REASON.HEADER_TOO_LARGE, `decoded envelope exceeds ${maxEnvelopeBytes} bytes`)
  }

  let parsed
  try {
    parsed = JSON.parse(decoded.toString('utf8'))
  } catch {
    return fail(REASON.MALFORMED_PAYMENT_HEADER, 'PAYMENT-SIGNATURE is not JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail(REASON.MALFORMED_PAYMENT_HEADER, 'envelope must be a JSON object')
  }

  if (parsed.x402Version !== X402_VERSION) {
    return fail(
      REASON.UNSUPPORTED_X402_VERSION,
      `envelope x402Version must be ${X402_VERSION}`,
    )
  }

  const accepted = parsed.accepted
  if (accepted === null || typeof accepted !== 'object' || Array.isArray(accepted)) {
    return fail(REASON.MALFORMED_PAYMENT_HEADER, 'envelope.accepted must be an object')
  }

  const payload = parsed.payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return fail(REASON.MALFORMED_PAYMENT_HEADER, 'envelope.payload must be an object')
  }
  if (typeof payload.txid !== 'string' || !TXID.test(payload.txid)) {
    return fail(REASON.INVALID_TXID, 'payload.txid must be 64 hexadecimal characters')
  }

  return {
    ok: true,
    envelope: Object.freeze({
      x402Version: parsed.x402Version,
      accepted: Object.freeze({ ...accepted }),
      // Lowercased so that a differently-cased txid cannot look like a new
      // payment to the receipt ledger.
      txid: payload.txid.toLowerCase(),
    }),
  }
}

/**
 * Compare the requirements a client says it accepted against the challenge we
 * issued. Every money-carrying field must match exactly: a lower `amount` or
 * a different `payTo` is a mismatch, not a negotiation.
 *
 * @param {import('../types/index.js').PaymentEnvelope} envelope
 * @param {import('../types/index.js').PaymentChallenge} challenge
 * @param {{ nowMs?: number }} [options]
 * @returns {{ ok: true } | { ok: false, reason: string, detail: string, mismatches?: string[] }}
 */
export function matchesChallenge(envelope, challenge, options = {}) {
  const nowMs = options.nowMs ?? Date.now()
  if (isChallengeExpired(challenge, nowMs)) {
    return {
      ok: false,
      reason: REASON.QUOTE_EXPIRED,
      detail: `quote ${challenge.quoteId} expired at ${challenge.expiresAt}`,
    }
  }

  const want = challenge.requirements
  const got = envelope.accepted
  const mismatches = []

  for (const field of ['scheme', 'network', 'asset', 'payTo']) {
    if (got[field] !== want[field]) mismatches.push(field)
  }

  const gotAmount = parseZatoshis(got.amount)
  if (!gotAmount.ok || gotAmount.value !== BigInt(want.amount)) {
    mismatches.push('amount')
  }

  if (got.maxTimeoutSeconds !== want.maxTimeoutSeconds) {
    mismatches.push('maxTimeoutSeconds')
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: REASON.REQUIREMENTS_MISMATCH,
      detail: `accepted requirements do not match quote ${challenge.quoteId}`,
      mismatches,
    }
  }

  return { ok: true }
}
