/**
 * The Helicopter Humans payment adapter: shielded Zcash in, verify-only.
 *
 * What it does: issues a server-owned x402 v2 challenge, checks a bounded
 * `PAYMENT-SIGNATURE` envelope against that challenge, asks CipherPay whether
 * the referenced Zcash transaction paid us, and grants a resource once per
 * txid through an injected ledger.
 *
 * What it never does: broadcast a transaction, create or hold a wallet, take
 * a seed phrase / spend key / viewing key, swap an asset, call `/settle`, or
 * move funds.
 */

import { parseZatoshis, formatZec } from './amounts.js'
import { ASSET, resolveConfig, SCHEME, SUPPORTED_NETWORK, X402_VERSION } from './config.js'
import {
  createPaymentChallenge,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_QUOTE_TTL_SECONDS,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  paymentRequiredBody,
} from './challenge.js'
import { matchesChallenge, parsePaymentSignature } from './envelope.js'
import { AdapterConfigurationError, UnsafeLedgerError } from './errors.js'
import { CipherPayFacilitator } from './facilitator.js'
import { assertReceiptLedger, CLAIM, merchantScopeFromApiKey, RECORD_STATE } from './ledger.js'
import { OPERATOR_FACING_REASONS, OUTCOME, REASON } from './outcomes.js'
import { challengeClaims, createQuoteSigner, deriveQuoteSigningSecret } from './quote-signing.js'

export const ADAPTER_ID = 'cipherpay-zcash-shielded'

/**
 * Shown to users verbatim. Every line is a claim 49TH-12 established; the
 * overclaims it rejected ("the buyer reveals nothing", "x402 payments are
 * private") are deliberately absent.
 */
export const PRIVACY_NOTE = [
  'You pay in shielded ZEC, directly to our address. The public Zcash chain does not show the sender, the receiver or the amount.',
  'CipherPay holds a read-only viewing key for our address. CipherPay and we can see that a payment arrived and for how much; neither of us learns your Zcash address.',
  'Your IP address and HTTP request are outside Zcash. A shielded transaction does not hide them.',
  'Payment is one-way. There is no automatic refund, and a refund is only possible by hand if you leave a shielded return address in the transaction memo.',
].join(' ')

/**
 * Why no live paid route may be exposed yet, regardless of configuration.
 * This is not a TODO list for this package -- it is a gate for whoever wires
 * a route, and `readyForLivePaidRoute` stays false until it is empty.
 */
export const INTEGRATION_BLOCKERS = Object.freeze([
  Object.freeze({
    id: 'no_payer_binding',
    summary:
      'A public txid alone does not prove that its submitter paid. POST /api/x402/v2/verify has no challenge, memo or caller binding, so anyone who observes a txid can present it. A receipt ledger stops replay, not first-claim theft.',
    resolvedBy:
      'A provider-supported invoice or memo binding, or another payer-binding method verified against primary sources.',
  }),
  Object.freeze({
    id: 'no_end_to_end_payment',
    summary:
      'No shielded payment has been verified end to end. Hosted discovery and the 401 gate were exercised on 2026-09-30; Ironwood decryption is in published source, not proven on the deployed host.',
    resolvedBy: 'One authorised tiny mainnet payment that this adapter verifies.',
  }),
  Object.freeze({
    id: 'no_confirmed_payer',
    summary:
      'No confirmed client can build an Ironwood shielded spend. @cipherpay/zipher-cli 0.3.0 predates Ironwood activation, and @x402/fetch will not construct a zcash:mainnet payment.',
    resolvedBy: 'A payer that demonstrably builds a fully shielded spend to our unified address.',
  }),
  Object.freeze({
    id: 'no_durable_ledger_deployed',
    summary:
      'A durable, shared receipt ledger must be deployed. A Vercel instance’s memory or filesystem is not one.',
    resolvedBy: 'A ledger whose claim operation is atomic across every instance serving the route.',
  }),
])

/** Buyer-safe wording per outcome. Never leaks an operator-side problem. */
const BUYER_MESSAGE = Object.freeze({
  [REASON.NOT_CONFIGURED]: 'Payments are not enabled on this deployment.',
  [REASON.MISSING_PAYMENT_HEADER]: 'Payment is required for this resource.',
  [REASON.MALFORMED_PAYMENT_HEADER]: 'The payment header could not be read. Re-send it for the same transaction.',
  [REASON.HEADER_TOO_LARGE]: 'The payment header was too large to read.',
  [REASON.UNSUPPORTED_X402_VERSION]: 'Only x402 version 2 is supported here.',
  [REASON.REQUIREMENTS_MISMATCH]: 'The payment terms you accepted are not the ones this quote offered.',
  // Someone reading this may already have paid. Never tell them to start over
  // in a way that reads as "pay again": the transaction is already on chain and
  // the same txid settles the fresh quote.
  [REASON.QUOTE_EXPIRED]:
    'This quote expired. Request the resource again for a fresh quote, then re-send the same transaction id against it. Do not send a second payment.',
  [REASON.INVALID_TXID]: 'The transaction id was not 64 hexadecimal characters. Re-send it for the same transaction.',
  [REASON.TRANSACTION_NOT_VISIBLE]: 'Your transaction is not visible yet. Retry with the same payment header; do not send a second payment.',
  [REASON.INSUFFICIENT_FUNDS]: 'The amount received does not cover this quote.',
  [REASON.NOT_ADDRESSED_TO_MERCHANT]: 'No shielded output in that transaction pays this address.',
  [REASON.FACILITATOR_REJECTED]: 'The payment was not accepted for this quote.',
  [REASON.TXID_ALREADY_CLAIMED]: 'That transaction has already been used for another request.',
  [REASON.MERCHANT_UNAUTHORIZED]: 'Payment verification is temporarily unavailable. Your payment was not assessed.',
  [REASON.MERCHANT_BILLING_BLOCKED]: 'Payment verification is temporarily unavailable. Your payment was not assessed.',
  [REASON.LEDGER_UNAVAILABLE]: 'Payment verification is temporarily unavailable. Your payment was not assessed.',
  [REASON.LEDGER_CONTRACT_VIOLATION]: 'Payment verification is temporarily unavailable. Your payment was not assessed.',
  [REASON.QUOTE_NOT_ISSUED]:
    'This quote was not issued by this server, or it has been altered. Request the resource again for a fresh quote, then re-send the same transaction id. Do not send a second payment.',
  [REASON.CHALLENGE_CONFIG_DRIFT]: 'Payment verification is temporarily unavailable. Your payment was not assessed.',
  [REASON.FACILITATOR_UNAVAILABLE]: 'Could not reach payment verification. Retry with the same payment header.',
  [REASON.FACILITATOR_TIMEOUT]: 'Payment verification timed out. Retry with the same payment header.',
  [REASON.FACILITATOR_BAD_RESPONSE]: 'Payment verification is temporarily unavailable. Your payment was not assessed.',
  [REASON.CANCELLED]: 'The verification request was cancelled.',
})

function httpStatusFor(kind, reason) {
  switch (kind) {
    case OUTCOME.VERIFIED:
      return 200
    // 202, not a second 402: re-sending a challenge for a payment that has
    // already been broadcast is how a buyer ends up paying twice.
    case OUTCOME.PENDING:
      return 202
    case OUTCOME.PAYMENT_REQUIRED:
    case OUTCOME.REJECTED:
      return 402
    case OUTCOME.DISABLED:
      return 503
    case OUTCOME.UPSTREAM_ERROR:
      return reason === REASON.FACILITATOR_TIMEOUT ? 504 : 503
    default:
      return 500
  }
}

export function createPaymentAdapter(options = {}) {
  const {
    env,
    config: providedConfig,
    ledger: providedLedger,
    facilitator: providedFacilitator,
    fetch: fetchImpl,
    now = Date.now,
    logger,
    merchantId: providedMerchantId,
    allowEphemeralLedger = false,
    quoteTtlSeconds = DEFAULT_QUOTE_TTL_SECONDS,
    maxTimeoutSeconds = DEFAULT_MAX_TIMEOUT_SECONDS,
    limits = {},
    resourceForProduct = defaultResourceForProduct,
    facilitatorOptions = {},
    quoteSigningSecret,
  } = options

  const resolved =
    providedConfig === undefined
      ? resolveConfig(env)
      : { mode: providedConfig.hostedFacilitator ? 'live' : 'test', problems: Object.freeze([]), config: providedConfig }

  const base = {
    id: ADAPTER_ID,
    scheme: SCHEME,
    asset: ASSET,
    supportedNetwork: SUPPORTED_NETWORK,
    privacyNote: PRIVACY_NOTE,
    integrationBlockers: INTEGRATION_BLOCKERS,
    // Stays false while INTEGRATION_BLOCKERS is non-empty. Do not expose a
    // live paid route while this is false, however good the config looks.
    readyForLivePaidRoute: INTEGRATION_BLOCKERS.length === 0,
  }

  if (resolved.mode === 'disabled') {
    return Object.freeze({
      ...base,
      mode: 'disabled',
      configProblems: resolved.problems,
      warnings: Object.freeze([]),
      createChallenge: disabledThrow,
      // Async, so a consumer holding the site's `PaymentAdapter` contract
      // gets a rejected promise rather than a synchronous throw.
      async quote() {
        return disabledThrow()
      },
      async authorize() {
        return disabledOutcome(resolved.problems)
      },
      async settle(quote) {
        return {
          status: 'failed',
          quoteId: quote?.quoteId ?? 'unknown',
          reason: BUYER_MESSAGE[REASON.NOT_CONFIGURED],
          retryable: false,
        }
      },
    })
  }

  const config = resolved.config
  const ledger = assertReceiptLedger(providedLedger)
  const warnings = []

  if (!ledger.durable) {
    if (!allowEphemeralLedger) {
      throw new UnsafeLedgerError(
        'refusing to collect payments with a non-durable receipt ledger: two instances would each grant a resource for the same txid. Inject a ledger with durable === true, or pass allowEphemeralLedger: true for tests.',
      )
    }
    warnings.push(
      'ephemeral receipt ledger: replay protection does not survive a second process, instance or deploy',
    )
  }

  const merchantId = providedMerchantId ?? merchantScopeFromApiKey(config.apiKey)

  // Quote ids carry a mac over their own terms, so `settle` can tell a quote we
  // issued from one a caller assembled or edited. Derived from the API key
  // unless given explicitly -- see `deriveQuoteSigningSecret` on rotation.
  if (quoteSigningSecret === undefined && (typeof config.apiKey !== 'string' || config.apiKey === '')) {
    throw new AdapterConfigurationError(
      'cannot sign quotes: pass quoteSigningSecret, or supply a config with an apiKey to derive one from',
    )
  }
  const signer = createQuoteSigner({
    secret: quoteSigningSecret ?? deriveQuoteSigningSecret(config.apiKey),
  })
  const signQuoteId = (nonce, claims) => signer.issue(nonce, claims)
  const facilitator =
    providedFacilitator ??
    new CipherPayFacilitator({ config, fetch: fetchImpl, logger, ...facilitatorOptions })

  function createChallenge({ resource, productId = null, quoteId, ttlSeconds = quoteTtlSeconds } = {}) {
    return createPaymentChallenge({
      config,
      resource,
      productId,
      signQuoteId,
      quoteId,
      ttlSeconds,
      maxTimeoutSeconds,
      now,
    })
  }

  /**
   * Compatibility shim for the site's `PaymentAdapter` contract
   * (`src/payments/types.ts`). `fee` is "0" because this adapter charges the
   * payer nothing of its own: the payer additionally pays a Zcash network fee
   * we do not quote, and CipherPay bills the merchant separately.
   */
  async function quote({ productId }) {
    if (typeof productId !== 'string' || productId === '') {
      throw new AdapterConfigurationError('productId must be a non-empty string')
    }
    const challenge = createChallenge({ productId, resource: resourceForProduct(productId) })
    return {
      quoteId: challenge.quoteId,
      productId,
      amount: challenge.requirements.amount,
      fee: '0',
      asset: challenge.requirements.asset,
      network: challenge.requirements.network,
      payTo: challenge.requirements.payTo,
      expiresAt: challenge.expiresAt,
    }
  }

  /**
   * Decide whether one request may have the resource.
   *
   * @param {object} args
   * @param {import('../types/index.js').PaymentChallenge} args.challenge  the
   *   challenge WE issued. Look it up by quote id; never rebuild it from
   *   request input.
   * @param {string|undefined} args.paymentSignatureHeader
   * @param {string} [args.requestId] local correlation id, defaults to the
   *   quote id. It is not payer authentication -- see INTEGRATION_BLOCKERS.
   * @param {AbortSignal} [args.signal]
   */
  async function authorize({ challenge, paymentSignatureHeader, requestId, signal }) {
    if (challenge === null || typeof challenge !== 'object' || challenge.requirements === undefined) {
      throw new AdapterConfigurationError('authorize requires a challenge created by this adapter')
    }

    // Both guards below run BEFORE ledger.claim, on purpose: a challenge we
    // will not honour must not leave a reserved txid behind, and must produce
    // an outcome a route can serve rather than an exception thrown from
    // somewhere deeper (the facilitator used to throw on a foreign scheme
    // after the claim was already taken).
    const drift = challengeConfigDrift(challenge, config)
    if (drift !== null) {
      return outcome({
        kind: OUTCOME.UPSTREAM_ERROR,
        reason: REASON.CHALLENGE_CONFIG_DRIFT,
        detail: drift,
        challenge,
        operatorActionRequired: true,
      })
    }
    if (!signer.verify(challenge.quoteId, challengeClaims(challenge))) {
      return outcome({
        kind: OUTCOME.UPSTREAM_ERROR,
        reason: REASON.QUOTE_NOT_ISSUED,
        detail:
          'challenge quote id does not carry this server\'s mac over its own terms: it was not issued here, it was edited, or the signing secret changed',
        challenge,
        operatorActionRequired: true,
      })
    }

    const claimRequestId = requestId ?? challenge.quoteId
    const resourceUrl = challenge.resource.url
    const nowMs = now()

    const parsed = parsePaymentSignature(paymentSignatureHeader, limits)
    if (!parsed.ok) {
      // A fresh challenge goes out only when no proof at all was presented.
      // Any other failure may sit on top of a payment that was already
      // broadcast, and re-quoting it invites a second transfer.
      if (parsed.reason === REASON.MISSING_PAYMENT_HEADER) {
        return outcome({
          kind: OUTCOME.PAYMENT_REQUIRED,
          reason: parsed.reason,
          detail: parsed.detail,
          challenge,
          reissue: true,
        })
      }
      return outcome({
        kind: OUTCOME.REJECTED,
        reason: parsed.reason,
        detail: parsed.detail,
        challenge,
        retrySameProofSafe: true,
      })
    }

    const match = matchesChallenge(parsed.envelope, challenge, { nowMs })
    if (!match.ok) {
      return outcome({
        kind: OUTCOME.REJECTED,
        reason: match.reason,
        detail: match.detail,
        challenge,
        mismatches: match.mismatches,
      })
    }

    const txid = parsed.envelope.txid
    const claimKey = {
      network: challenge.requirements.network,
      merchantId,
      txid,
      requestId: claimRequestId,
      amountZatoshis: challenge.requirements.amount,
      // One txid buys one resource. Stored, not merely passed: an owned record
      // for a different resource is a replay, not a retry.
      resource: resourceUrl,
    }

    let claimed
    try {
      claimed = await ledger.claim(claimKey)
    } catch (error) {
      logger?.error?.({ event: 'ledger_claim_failed', txid, error: error?.name ?? 'Error' })
      return outcome({
        kind: OUTCOME.UPSTREAM_ERROR,
        reason: REASON.LEDGER_UNAVAILABLE,
        detail: 'the receipt ledger is unavailable; no resource was granted',
        challenge,
        txid,
        operatorActionRequired: true,
        retrySameProofSafe: true,
      })
    }

    if (claimed.status === CLAIM.TAKEN) {
      return outcome({
        kind: OUTCOME.REJECTED,
        reason: REASON.TXID_ALREADY_CLAIMED,
        detail: `txid already claimed by request ${claimed.record.requestId} for ${claimed.record.amountZatoshis} zatoshis and resource ${claimed.record.resource}`,
        challenge,
        txid,
      })
    }

    // Do not trust an injected ledger to have compared the resource. A ledger
    // that drops the field would silently replay one payment across resources,
    // so a record that does not carry ours back is refused here.
    if (typeof claimed.record.resource !== 'string') {
      return outcome({
        kind: OUTCOME.UPSTREAM_ERROR,
        reason: REASON.LEDGER_CONTRACT_VIOLATION,
        detail: 'the receipt ledger did not store the claimed resource; no resource was granted',
        challenge,
        txid,
        operatorActionRequired: true,
      })
    }
    if (claimed.record.resource !== resourceUrl) {
      return outcome({
        kind: OUTCOME.REJECTED,
        reason: REASON.TXID_ALREADY_CLAIMED,
        detail: `txid already claimed for resource ${claimed.record.resource}, not ${resourceUrl}`,
        challenge,
        txid,
      })
    }

    // A retry of the same authorised request returns its stored result rather
    // than re-verifying and re-granting.
    if (claimed.status === CLAIM.OWNED && claimed.record.state === RECORD_STATE.GRANTED) {
      return outcome({
        kind: OUTCOME.VERIFIED,
        challenge,
        txid,
        replay: true,
        verifiedAt: claimed.record.updatedAt,
      })
    }
    if (claimed.status === CLAIM.OWNED && claimed.record.state === RECORD_STATE.REJECTED) {
      const stored = claimed.record.outcome ?? {}
      return outcome({
        kind: OUTCOME.REJECTED,
        reason: stored.reason ?? REASON.FACILITATOR_REJECTED,
        detail: stored.detail ?? 'this payment was already rejected for this request',
        challenge,
        txid,
        replay: true,
      })
    }

    const verification = await facilitator.verify({ challenge, txid, signal })

    if (verification.kind === OUTCOME.VERIFIED) {
      try {
        const record = await ledger.settle({
          ...claimKey,
          state: RECORD_STATE.GRANTED,
          outcome: { reason: null, detail: 'verified by CipherPay' },
        })
        return outcome({ kind: OUTCOME.VERIFIED, challenge, txid, replay: false, verifiedAt: record.updatedAt })
      } catch (error) {
        // Verified upstream but we could not durably record the grant.
        // Fail closed: granting without a receipt is how one txid buys twice.
        logger?.error?.({ event: 'ledger_settle_failed', txid, error: error?.name ?? 'Error' })
        return outcome({
          kind: OUTCOME.UPSTREAM_ERROR,
          reason: REASON.LEDGER_UNAVAILABLE,
          detail: 'the payment verified but the receipt could not be recorded; no resource was granted',
          challenge,
          txid,
          operatorActionRequired: true,
          retrySameProofSafe: true,
        })
      }
    }

    if (verification.kind === OUTCOME.REJECTED) {
      await ledger
        .settle({
          ...claimKey,
          state: RECORD_STATE.REJECTED,
          outcome: { reason: verification.reason, detail: verification.detail },
        })
        .catch((error) => {
          logger?.error?.({ event: 'ledger_settle_failed', txid, error: error?.name ?? 'Error' })
        })
      return outcome({
        kind: OUTCOME.REJECTED,
        reason: verification.reason,
        detail: verification.detail,
        challenge,
        txid,
      })
    }

    // PENDING and UPSTREAM_ERROR leave the claim reserved, so this request can
    // retry the same txid and nobody else can take it in the meantime.
    if (verification.kind === OUTCOME.PENDING) {
      return outcome({
        kind: OUTCOME.PENDING,
        reason: verification.reason,
        detail: verification.detail,
        challenge,
        txid,
        retryAfterSeconds: Math.min(challenge.requirements.maxTimeoutSeconds, 15),
        retrySameProofSafe: true,
      })
    }

    return outcome({
      kind: OUTCOME.UPSTREAM_ERROR,
      reason: verification.reason,
      detail: verification.detail,
      challenge,
      txid,
      operatorActionRequired: verification.operatorActionRequired === true,
      retrySameProofSafe: verification.reason !== REASON.CANCELLED,
    })
  }

  /** Site-contract `settle`. Maps an authorize outcome onto `PaymentResult`. */
  async function settle(quoteObject, proof, signal) {
    const rebuilt = challengeFromQuote(quoteObject, config, maxTimeoutSeconds, resourceForProduct, signer)
    if (!rebuilt.ok) {
      return { status: 'failed', quoteId: quoteObject?.quoteId ?? 'unknown', reason: rebuilt.reason, retryable: false }
    }

    const header = normaliseProof(proof, rebuilt.challenge)
    const result = await authorize({
      challenge: rebuilt.challenge,
      paymentSignatureHeader: header,
      requestId: rebuilt.challenge.quoteId,
      signal,
    })

    const quoteId = rebuilt.challenge.quoteId
    switch (result.kind) {
      case OUTCOME.VERIFIED:
        return { status: 'succeeded', quoteId, reference: result.txid }
      case OUTCOME.PENDING:
        return { status: 'pending', quoteId, reference: result.txid }
      case OUTCOME.UPSTREAM_ERROR:
        if (result.reason === REASON.CANCELLED) return { status: 'cancelled', quoteId }
        return { status: 'failed', quoteId, reason: result.buyerMessage, retryable: true }
      default:
        return { status: 'failed', quoteId, reason: result.buyerMessage, retryable: false }
    }
  }

  return Object.freeze({
    ...base,
    mode: resolved.mode,
    network: config.network,
    payTo: config.payTo,
    priceZatoshis: config.priceZatoshis.toString(),
    priceZec: formatZec(config.priceZatoshis),
    merchantId,
    configProblems: Object.freeze([]),
    warnings: Object.freeze(warnings),
    verifyUrl: facilitator.verifyUrl,
    createChallenge,
    quote,
    authorize,
    settle,
  })
}

function defaultResourceForProduct(productId) {
  return {
    url: `urn:helicopter-humans:product:${productId}`,
    description: `Helicopter Humans: ${productId}`,
    mimeType: 'application/json',
  }
}

function disabledThrow() {
  throw new AdapterConfigurationError(
    'the payment adapter is disabled; inspect configProblems before calling this',
  )
}

function disabledOutcome(problems) {
  return Object.freeze({
    kind: OUTCOME.DISABLED,
    reason: REASON.NOT_CONFIGURED,
    detail: problems.join('; '),
    buyerMessage: BUYER_MESSAGE[REASON.NOT_CONFIGURED],
    operatorActionRequired: true,
    httpStatus: httpStatusFor(OUTCOME.DISABLED, REASON.NOT_CONFIGURED),
    headers: Object.freeze({}),
    body: Object.freeze({ error: REASON.NOT_CONFIGURED }),
  })
}

/**
 * Refuse a challenge whose terms drifted from current configuration -- a stale
 * or tampered quote must not set the price, the destination, the scheme or the
 * asset. `scheme` and `asset` are pinned here and not only in the envelope
 * comparison: the facilitator raises on an unknown scheme, and it does so after
 * the txid has already been reserved.
 *
 * Returns an operator-facing description, or null when the challenge is fine.
 *
 * @returns {string|null}
 */
function challengeConfigDrift(challenge, config) {
  const r = challenge.requirements
  if (r.scheme !== SCHEME) {
    return `challenge scheme ${JSON.stringify(r.scheme)} is not the only supported scheme ${SCHEME}`
  }
  if (r.asset !== ASSET) {
    return `challenge asset ${JSON.stringify(r.asset)} is not the only supported asset ${ASSET}`
  }
  if (r.payTo !== config.payTo) {
    return 'challenge payTo does not match the configured destination'
  }
  if (r.network !== config.network) {
    return 'challenge network does not match the configured network'
  }
  if (r.amount !== config.priceZatoshis.toString()) {
    return 'challenge amount does not match the configured price'
  }
  return null
}

/**
 * Rebuild the challenge for a quote the caller handed back to `settle`.
 *
 * Comparing the money fields against configuration is NOT enough on its own:
 * every quote this server issues carries the same amount, destination and
 * network, so a quote we never issued -- or one of ours with `expiresAt` moved
 * into 2099, or `productId` swapped for a dearer one -- passes that check
 * unchanged. The quote id's mac is what settles it: it covers the product, the
 * resource, the scheme, the asset, the amount, the destination, the timeout and
 * the expiry, so exactly the quotes we issued verify.
 *
 * Failures here are non-retryable by design. A caller cannot fix a quote we
 * never issued by sending it again.
 */
function challengeFromQuote(quoteObject, config, maxTimeoutSeconds, resourceForProduct, signer) {
  if (quoteObject === null || typeof quoteObject !== 'object') {
    return { ok: false, reason: 'a quote is required' }
  }
  const amount = parseZatoshis(quoteObject.amount)
  if (!amount.ok) return { ok: false, reason: `quote amount is unusable: ${amount.reason}` }
  if (
    quoteObject.payTo !== config.payTo ||
    quoteObject.network !== config.network ||
    quoteObject.asset !== ASSET ||
    amount.value !== config.priceZatoshis
  ) {
    return { ok: false, reason: 'this quote does not match current server configuration' }
  }
  if (typeof quoteObject.quoteId !== 'string' || quoteObject.quoteId === '') {
    return { ok: false, reason: 'quote is missing a quoteId' }
  }
  if (typeof quoteObject.productId !== 'string' || quoteObject.productId === '') {
    return { ok: false, reason: 'quote is missing a productId' }
  }
  if (typeof quoteObject.expiresAt !== 'string' || Number.isNaN(Date.parse(quoteObject.expiresAt))) {
    return { ok: false, reason: 'quote is missing a usable expiresAt' }
  }

  const resource = resourceForProduct(quoteObject.productId)
  const challenge = Object.freeze({
    quoteId: quoteObject.quoteId,
    productId: quoteObject.productId,
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
      amount: config.priceZatoshis.toString(),
      payTo: config.payTo,
      maxTimeoutSeconds,
      extra: Object.freeze({}),
    }),
    // Not signed: the site's `Quote` shape does not carry it, so `settle` could
    // not reproduce it. Nothing is decided on it -- expiry reads `expiresAt`.
    createdAt: quoteObject.createdAt ?? quoteObject.expiresAt,
    expiresAt: quoteObject.expiresAt,
  })

  if (!signer.verify(challenge.quoteId, challengeClaims(challenge))) {
    return {
      ok: false,
      reason: BUYER_MESSAGE[REASON.QUOTE_NOT_ISSUED],
    }
  }

  return { ok: true, challenge }
}

/** Accept either a bare 64-hex txid or a full `PAYMENT-SIGNATURE` value. */
function normaliseProof(proof, challenge) {
  if (typeof proof !== 'string') return undefined
  const trimmed = proof.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: { ...challenge.requirements, extra: {} },
        payload: { txid: trimmed.toLowerCase() },
      }),
      'utf8',
    ).toString('base64')
  }
  return trimmed
}

function outcome({
  kind,
  reason,
  detail,
  challenge,
  txid,
  reissue = false,
  replay = false,
  verifiedAt,
  retryAfterSeconds,
  operatorActionRequired = false,
  retrySameProofSafe = false,
  mismatches,
}) {
  const headers = {}
  const body = {}

  if (kind === OUTCOME.VERIFIED) {
    headers['PAYMENT-RESPONSE'] = encodePaymentResponseHeader({
      txid,
      network: challenge.requirements.network,
    })
  } else if (reissue) {
    headers['PAYMENT-REQUIRED'] = encodePaymentRequiredHeader(challenge)
    Object.assign(body, paymentRequiredBody(challenge))
  }

  if (retryAfterSeconds !== undefined) {
    headers['Retry-After'] = String(retryAfterSeconds)
  }

  if (reason !== undefined) {
    body.reason = reason
    body.message = BUYER_MESSAGE[reason] ?? 'Payment could not be completed.'
  }
  if (retrySameProofSafe) {
    body.retryWithSamePayment = true
  }

  return Object.freeze({
    kind,
    reason,
    detail,
    mismatches: mismatches === undefined ? undefined : Object.freeze([...mismatches]),
    quoteId: challenge.quoteId,
    txid,
    replay,
    verifiedAt,
    retryAfterSeconds,
    operatorActionRequired,
    retrySameProofSafe,
    // True when `reason` describes our problem rather than the buyer's
    // payment. A route must show `buyerMessage`, never `detail`.
    operatorFacing: reason !== undefined && OPERATOR_FACING_REASONS.has(reason),
    buyerMessage: reason === undefined ? 'Payment verified.' : (BUYER_MESSAGE[reason] ?? 'Payment could not be completed.'),
    httpStatus: httpStatusFor(kind, reason),
    headers: Object.freeze(headers),
    body: Object.freeze(body),
  })
}
