/**
 * @helicopter-humans/payment-adapter
 *
 * Verify-only CipherPay x402 v2 client for shielded Zcash payments.
 * See README.md for the request/response contract and the integration
 * blockers that must be cleared before a live paid route is exposed.
 */

export {
  ADAPTER_ID,
  createPaymentAdapter,
  INTEGRATION_BLOCKERS,
  PRIVACY_NOTE,
} from './src/adapter.js'

export {
  ASSET,
  ENV_KEYS,
  HOSTED_FACILITATOR_URL,
  resolveConfig,
  SCHEME,
  SUPPORTED_NETWORK,
  VERIFY_PATH,
  X402_VERSION,
} from './src/config.js'

export {
  createPaymentChallenge,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_QUOTE_TTL_SECONDS,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  isChallengeExpired,
  paymentRequiredBody,
} from './src/challenge.js'

export {
  DEFAULT_MAX_ENVELOPE_BYTES,
  DEFAULT_MAX_HEADER_BYTES,
  matchesChallenge,
  parsePaymentSignature,
} from './src/envelope.js'

export { buildVerifyRequestBody, CipherPayFacilitator } from './src/facilitator.js'

export {
  assertReceiptLedger,
  CLAIM,
  InMemoryReceiptLedger,
  merchantScopeFromApiKey,
  receiptKey,
  RECORD_STATE,
} from './src/ledger.js'

export { OPERATOR_FACING_REASONS, OUTCOME, REASON } from './src/outcomes.js'

export {
  challengeClaims,
  createQuoteSigner,
  deriveQuoteSigningSecret,
} from './src/quote-signing.js'

export {
  formatZec,
  MAX_ZATOSHIS,
  parseZatoshis,
  providerMinAcceptableZatoshis,
  ZATOSHIS_PER_ZEC,
} from './src/amounts.js'

export { AdapterConfigurationError, LedgerContractError, UnsafeLedgerError } from './src/errors.js'
