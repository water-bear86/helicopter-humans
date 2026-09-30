import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createPaymentChallenge as issueChallenge } from '../src/challenge.js'
import { resolveConfig } from '../src/config.js'
import { matchesChallenge, parsePaymentSignature } from '../src/envelope.js'
import { REASON } from '../src/outcomes.js'
import { FIXTURE_TXID, fixtureEnv, paymentSignature, fixtureSignQuoteId } from './helpers/fixtures.js'

const { config } = resolveConfig(fixtureEnv())

// Every challenge here is signed: `authorize` refuses an unsigned quote id.
const createPaymentChallenge = (args) => issueChallenge({ signQuoteId: fixtureSignQuoteId, ...args })
const resource = { url: 'https://example.test/api/v1/privacy-check' }
const challengeAt = (nowMs) => createPaymentChallenge({ config, resource, now: () => nowMs })

function encode(object) {
  return Buffer.from(JSON.stringify(object), 'utf8').toString('base64')
}

describe('parsePaymentSignature', () => {
  it('accepts a well-formed envelope and lower-cases the txid', () => {
    const challenge = challengeAt(0)
    const parsed = parsePaymentSignature(paymentSignature(challenge, { txid: 'A'.repeat(64) }))
    assert.equal(parsed.ok, true)
    assert.equal(parsed.envelope.txid, 'a'.repeat(64))
  })

  it('reports a missing header distinctly from a malformed one', () => {
    assert.equal(parsePaymentSignature(undefined).reason, REASON.MISSING_PAYMENT_HEADER)
    assert.equal(parsePaymentSignature('').reason, REASON.MISSING_PAYMENT_HEADER)
    assert.equal(parsePaymentSignature('not base64!!').reason, REASON.MALFORMED_PAYMENT_HEADER)
    assert.equal(parsePaymentSignature(['a', 'b']).reason, REASON.MALFORMED_PAYMENT_HEADER)
  })

  it('bounds the header before decoding it', () => {
    const huge = 'A'.repeat(20000)
    assert.equal(parsePaymentSignature(huge).reason, REASON.HEADER_TOO_LARGE)
    assert.equal(parsePaymentSignature(huge, { maxHeaderBytes: 64 }).reason, REASON.HEADER_TOO_LARGE)
  })

  it('bounds the decoded envelope as well as the header', () => {
    const padded = encode({ x402Version: 2, accepted: {}, payload: { txid: FIXTURE_TXID }, junk: 'x'.repeat(4000) })
    assert.equal(parsePaymentSignature(padded, { maxEnvelopeBytes: 512 }).reason, REASON.HEADER_TOO_LARGE)
  })

  it('rejects non-JSON, non-object and empty payloads', () => {
    assert.equal(parsePaymentSignature(Buffer.from('{oops', 'utf8').toString('base64')).reason, REASON.MALFORMED_PAYMENT_HEADER)
    assert.equal(parsePaymentSignature(encode([1, 2])).reason, REASON.MALFORMED_PAYMENT_HEADER)
    assert.equal(parsePaymentSignature(encode(null)).reason, REASON.MALFORMED_PAYMENT_HEADER)
  })

  it('rejects any x402 version other than 2', () => {
    const challenge = challengeAt(0)
    assert.equal(
      parsePaymentSignature(paymentSignature(challenge, { x402Version: 1 })).reason,
      REASON.UNSUPPORTED_X402_VERSION,
    )
  })

  it('rejects a txid that is not 64 hex characters', () => {
    const challenge = challengeAt(0)
    for (const txid of ['', 'abc', 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]) {
      assert.equal(parsePaymentSignature(paymentSignature(challenge, { txid })).reason, REASON.INVALID_TXID)
    }
    assert.equal(parsePaymentSignature(encode({ x402Version: 2, accepted: {}, payload: {} })).reason, REASON.INVALID_TXID)
  })

  it('rejects a missing or non-object accepted / payload', () => {
    assert.equal(parsePaymentSignature(encode({ x402Version: 2, payload: { txid: FIXTURE_TXID } })).reason, REASON.MALFORMED_PAYMENT_HEADER)
    assert.equal(parsePaymentSignature(encode({ x402Version: 2, accepted: {} })).reason, REASON.MALFORMED_PAYMENT_HEADER)
  })
})

describe('matchesChallenge', () => {
  it('accepts an envelope that echoes our requirements exactly', () => {
    const challenge = challengeAt(0)
    const parsed = parsePaymentSignature(paymentSignature(challenge))
    assert.deepEqual(matchesChallenge(parsed.envelope, challenge, { nowMs: 1000 }), { ok: true })
  })

  it('rejects a client-supplied lower price', () => {
    const challenge = challengeAt(0)
    const parsed = parsePaymentSignature(
      paymentSignature(challenge, { accepted: { ...challenge.requirements, amount: '1' } }),
    )
    const result = matchesChallenge(parsed.envelope, challenge, { nowMs: 1000 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, REASON.REQUIREMENTS_MISMATCH)
    assert.deepEqual(result.mismatches, ['amount'])
  })

  it('rejects a client-supplied different destination, network, scheme or asset', () => {
    const challenge = challengeAt(0)
    const cases = {
      payTo: 'u1attackerattackerattackerattackerattackerattackerattacker000000',
      network: 'zcash:testnet',
      scheme: 'upto',
      asset: 'USDC',
      maxTimeoutSeconds: 99999,
    }
    for (const [field, value] of Object.entries(cases)) {
      const parsed = parsePaymentSignature(
        paymentSignature(challenge, { accepted: { ...challenge.requirements, [field]: value } }),
      )
      const result = matchesChallenge(parsed.envelope, challenge, { nowMs: 1000 })
      assert.equal(result.ok, false, `expected a mismatch on ${field}`)
      assert.deepEqual(result.mismatches, [field])
    }
  })

  it('rejects a float or unparseable amount as a mismatch', () => {
    const challenge = challengeAt(0)
    for (const amount of ['100000.0', '1e5', 'abc', undefined]) {
      const parsed = parsePaymentSignature(
        paymentSignature(challenge, { accepted: { ...challenge.requirements, amount } }),
      )
      assert.deepEqual(matchesChallenge(parsed.envelope, challenge, { nowMs: 1000 }).mismatches, ['amount'])
    }
  })

  it('rejects an expired quote before looking at anything else', () => {
    const challenge = challengeAt(0)
    const parsed = parsePaymentSignature(paymentSignature(challenge))
    const result = matchesChallenge(parsed.envelope, challenge, { nowMs: 300_001 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, REASON.QUOTE_EXPIRED)
  })
})
