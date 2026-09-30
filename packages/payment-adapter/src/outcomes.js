/** The six outcome kinds this adapter can produce. Nothing else. */
export const OUTCOME = Object.freeze({
  /** No usable configuration. There is no paid route on this deployment. */
  DISABLED: 'disabled',
  /** No payment proof presented. A challenge is offered. */
  PAYMENT_REQUIRED: 'payment_required',
  /** Proof presented, not yet verifiable. Retry verification of the SAME txid. */
  PENDING: 'pending',
  /** The facilitator says this payment does not satisfy the requirements. */
  REJECTED: 'rejected',
  /** The facilitator confirmed the payment and the ledger granted this request. */
  VERIFIED: 'verified',
  /** Our side or the facilitator failed. Says nothing about the buyer's payment. */
  UPSTREAM_ERROR: 'upstream_error',
})

/** Stable machine-readable reasons. Safe to show a buyer except where noted. */
export const REASON = Object.freeze({
  NOT_CONFIGURED: 'not_configured',
  MISSING_PAYMENT_HEADER: 'missing_payment_header',
  MALFORMED_PAYMENT_HEADER: 'malformed_payment_header',
  HEADER_TOO_LARGE: 'header_too_large',
  UNSUPPORTED_X402_VERSION: 'unsupported_x402_version',
  REQUIREMENTS_MISMATCH: 'requirements_mismatch',
  QUOTE_EXPIRED: 'quote_expired',
  INVALID_TXID: 'invalid_txid',
  TRANSACTION_NOT_VISIBLE: 'transaction_not_visible',
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  NOT_ADDRESSED_TO_MERCHANT: 'not_addressed_to_merchant',
  FACILITATOR_REJECTED: 'facilitator_rejected',
  /** Operator-facing only: our API key, not the buyer's payment. */
  MERCHANT_UNAUTHORIZED: 'merchant_unauthorized',
  /** Operator-facing only: our CipherPay bill, not the buyer's payment. */
  MERCHANT_BILLING_BLOCKED: 'merchant_billing_blocked',
  /**
   * Operator-facing only: the challenge handed to `authorize` does not carry
   * our mac over its own terms, so this server did not issue it -- or the
   * signing secret changed under it.
   */
  QUOTE_NOT_ISSUED: 'quote_not_issued',
  /**
   * Operator-facing only: a challenge's scheme, asset, amount, destination or
   * network drifted from current configuration. Our bug or our config, never
   * the buyer's payment.
   */
  CHALLENGE_CONFIG_DRIFT: 'challenge_config_drift',
  /** Operator-facing only: the injected ledger broke its contract. */
  LEDGER_CONTRACT_VIOLATION: 'ledger_contract_violation',
  FACILITATOR_UNAVAILABLE: 'facilitator_unavailable',
  FACILITATOR_BAD_RESPONSE: 'facilitator_bad_response',
  FACILITATOR_TIMEOUT: 'facilitator_timeout',
  CANCELLED: 'cancelled',
  TXID_ALREADY_CLAIMED: 'txid_already_claimed',
  LEDGER_UNAVAILABLE: 'ledger_unavailable',
})

/**
 * Reasons that describe OUR problem, not the buyer's payment. A route must not
 * tell a buyer their payment was rejected because our merchant bill is unpaid.
 */
export const OPERATOR_FACING_REASONS = Object.freeze(
  new Set([
    REASON.MERCHANT_UNAUTHORIZED,
    REASON.MERCHANT_BILLING_BLOCKED,
    REASON.LEDGER_UNAVAILABLE,
    REASON.LEDGER_CONTRACT_VIOLATION,
    REASON.QUOTE_NOT_ISSUED,
    REASON.CHALLENGE_CONFIG_DRIFT,
  ]),
)
