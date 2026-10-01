import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { resolveConfig } from '../src/config.js'
import {
  createPaymentChallenge,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  isChallengeExpired,
  paymentRequiredBody,
} from '../src/challenge.js'
import { challengeClaims } from '../src/quote-signing.js'
import {
  FIXTURE_PAYTO_UA,
  FIXTURE_TXID,
  fixtureEnv,
  fixtureSigner,
  fixtureSignQuoteId,
} from './helpers/fixtures.js'

const { config } = resolveConfig(fixtureEnv())
const resource = { url: 'https://example.test/api/v1/privacy-check', description: 'One shielded privacy check' }
const signQuoteId = fixtureSignQuoteId

describe('createPaymentChallenge', () => {
  it('produces a challenge whose money fields come only from configuration', () => {
    const challenge = createPaymentChallenge({ config, resource, signQuoteId, now: () => 0 })

    assert.equal(challenge.x402Version, 2)
    assert.deepEqual(
      { ...challenge.requirements, extra: { ...challenge.requirements.extra } },
      {
        scheme: 'exact',
        network: 'zcash:mainnet',
        asset: 'ZEC',
        amount: '100000',
        payTo: FIXTURE_PAYTO_UA,
        maxTimeoutSeconds: 120,
        extra: {},
      },
    )
    assert.equal(typeof challenge.quoteId, 'string')
    assert.equal(challenge.createdAt, '1970-01-01T00:00:00.000Z')
    assert.equal(challenge.expiresAt, '1970-01-01T00:05:00.000Z')
  })

  it('keeps the amount an integer string, never a float', () => {
    const challenge = createPaymentChallenge({ config, resource, signQuoteId })
    assert.match(challenge.requirements.amount, /^[0-9]+$/)
  })

  it('gives every challenge a distinct quote id', () => {
    const a = createPaymentChallenge({ config, resource, signQuoteId })
    const b = createPaymentChallenge({ config, resource, signQuoteId })
    assert.notEqual(a.quoteId, b.quoteId)
  })

  it('seals its own terms into the quote id', () => {
    const challenge = createPaymentChallenge({ config, resource, signQuoteId, productId: 'privacy-check' })

    assert.equal(fixtureSigner.verify(challenge.quoteId, challengeClaims(challenge)), true)
    // Every field the mac covers, moved one at a time.
    for (const edited of [
      { ...challenge, productId: 'founding-pass' },
      { ...challenge, expiresAt: '2099-01-01T00:00:00.000Z' },
      { ...challenge, resource: { ...challenge.resource, url: 'https://example.test/other' } },
      { ...challenge, requirements: { ...challenge.requirements, amount: '1' } },
      { ...challenge, requirements: { ...challenge.requirements, payTo: 'u1someoneelse' } },
      { ...challenge, requirements: { ...challenge.requirements, scheme: 'bogus' } },
      { ...challenge, requirements: { ...challenge.requirements, asset: 'BTC' } },
      { ...challenge, requirements: { ...challenge.requirements, network: 'zcash:other' } },
      { ...challenge, requirements: { ...challenge.requirements, maxTimeoutSeconds: 9000 } },
    ]) {
      assert.equal(fixtureSigner.verify(edited.quoteId, challengeClaims(edited)), false)
    }
  })

  it('refuses to issue a quote nobody can verify', () => {
    assert.throws(() => createPaymentChallenge({ config, resource }), TypeError)
    assert.throws(
      () => createPaymentChallenge({ config, resource, signQuoteId, productId: '' }),
      TypeError,
    )
  })

  it('rejects a resource without a url and a non-positive ttl', () => {
    assert.throws(() => createPaymentChallenge({ config, resource, signQuoteId: {} }), TypeError)
    assert.throws(() => createPaymentChallenge({ config, resource, signQuoteId, ttlSeconds: 0 }), TypeError)
    assert.throws(() => createPaymentChallenge({ config, resource, signQuoteId, maxTimeoutSeconds: 1.5 }), TypeError)
  })
})

describe('isChallengeExpired', () => {
  it('expires exactly at expiresAt', () => {
    const challenge = createPaymentChallenge({ config, resource, signQuoteId, ttlSeconds: 300, now: () => 0 })
    assert.equal(isChallengeExpired(challenge, 299_999), false)
    assert.equal(isChallengeExpired(challenge, 300_000), true)
  })
})

describe('header encoding', () => {
  it('round-trips PAYMENT-REQUIRED as base64 of the 402 body', () => {
    const challenge = createPaymentChallenge({ config, resource, signQuoteId })
    const decoded = JSON.parse(Buffer.from(encodePaymentRequiredHeader(challenge), 'base64').toString('utf8'))
    assert.deepEqual(decoded, JSON.parse(JSON.stringify(paymentRequiredBody(challenge))))
    assert.equal(decoded.accepts.length, 1)
    assert.equal(decoded.accepts[0].amount, '100000')
  })

  it('encodes PAYMENT-RESPONSE as a verification confirmation, not a settlement receipt', () => {
    const decoded = JSON.parse(
      Buffer.from(encodePaymentResponseHeader({ txid: FIXTURE_TXID, network: 'zcash:mainnet' }), 'base64').toString('utf8'),
    )
    assert.deepEqual(decoded, { success: true, txid: FIXTURE_TXID, network: 'zcash:mainnet' })
  })
})
