import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import * as pkg from '../index.js'

describe('package surface', () => {
  it('exports everything an integrator needs from the package root', () => {
    for (const name of [
      'ADAPTER_ID',
      'createPaymentAdapter',
      'INTEGRATION_BLOCKERS',
      'PRIVACY_NOTE',
      'ENV_KEYS',
      'HOSTED_FACILITATOR_URL',
      'SUPPORTED_NETWORK',
      'VERIFY_PATH',
      'resolveConfig',
      'createPaymentChallenge',
      'encodePaymentRequiredHeader',
      'encodePaymentResponseHeader',
      'parsePaymentSignature',
      'matchesChallenge',
      'CipherPayFacilitator',
      'buildVerifyRequestBody',
      'InMemoryReceiptLedger',
      'assertReceiptLedger',
      'receiptKey',
      'CLAIM',
      'RECORD_STATE',
      'OUTCOME',
      'REASON',
      'createQuoteSigner',
      'deriveQuoteSigningSecret',
      'challengeClaims',
      'parseZatoshis',
      'providerMinAcceptableZatoshis',
      'UnsafeLedgerError',
      'LedgerContractError',
      'AdapterConfigurationError',
    ]) {
      assert.ok(pkg[name] !== undefined, `missing export ${name}`)
    }
  })

  it('names the verify endpoint and network this package was written against', () => {
    assert.equal(pkg.VERIFY_PATH, '/api/x402/v2/verify')
    assert.equal(pkg.HOSTED_FACILITATOR_URL, 'https://api.cipherpay.app')
    assert.equal(pkg.SUPPORTED_NETWORK, 'zcash:mainnet')
    assert.equal(pkg.X402_VERSION, 2)
    assert.equal(pkg.SCHEME, 'exact')
    assert.equal(pkg.ASSET, 'ZEC')
  })

  it('exposes exactly the six outcome kinds', () => {
    assert.deepEqual(Object.values(pkg.OUTCOME).sort(), [
      'disabled',
      'payment_required',
      'pending',
      'rejected',
      'upstream_error',
      'verified',
    ])
  })
})
