/**
 * Error types raised by configuration and construction. Runtime payment
 * outcomes are never exceptions -- they are structured outcomes. See
 * `src/outcomes.js`.
 */

/** Programmer error: the adapter was constructed with an unusable argument. */
export class AdapterConfigurationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'AdapterConfigurationError'
  }
}

/**
 * Fail-closed guard. Raised when a payment-collecting adapter would run
 * without a durable, shared receipt ledger. A single process's memory or a
 * serverless instance's filesystem is not a ledger: two concurrent instances
 * would each grant a resource for the same txid.
 */
export class UnsafeLedgerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsafeLedgerError'
  }
}

/** The injected ledger violated its contract (e.g. settle by a non-owner). */
export class LedgerContractError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerContractError'
  }
}
