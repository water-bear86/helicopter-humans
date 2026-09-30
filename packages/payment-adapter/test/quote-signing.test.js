import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { resolveConfig } from '../src/config.js'
import {
  challengeClaims,
  createQuoteSigner,
  deriveQuoteSigningSecret,
} from '../src/quote-signing.js'
import { FIXTURE_API_KEY, fixtureChallenge, fixtureEnv } from './helpers/fixtures.js'

const { config } = resolveConfig(fixtureEnv())
const signer = createQuoteSigner({ secret: 'a-test-secret' })

describe('deriveQuoteSigningSecret', () => {
  it('is stable, is not the api key, and moves when the key rotates', () => {
    const secret = deriveQuoteSigningSecret(FIXTURE_API_KEY)
    assert.deepEqual(secret, deriveQuoteSigningSecret(FIXTURE_API_KEY))
    assert.equal(secret.length, 32)
    assert.equal(secret.includes(Buffer.from(FIXTURE_API_KEY, 'utf8')), false)
    assert.notDeepEqual(secret, deriveQuoteSigningSecret(`${FIXTURE_API_KEY}-rotated`))
  })

  it('refuses to derive from nothing', () => {
    assert.throws(() => deriveQuoteSigningSecret(''), TypeError)
    assert.throws(() => deriveQuoteSigningSecret(undefined), TypeError)
  })
})

describe('createQuoteSigner', () => {
  it('needs a secret', () => {
    assert.throws(() => createQuoteSigner({ secret: '' }), TypeError)
    assert.throws(() => createQuoteSigner({}), TypeError)
  })

  it('round-trips a quote id it issued', () => {
    const claims = challengeClaims(fixtureChallenge(config))
    const quoteId = signer.issue('nonce-1', claims)
    assert.equal(signer.verify(quoteId, claims), true)
  })

  it('rejects a quote id from another secret', () => {
    const claims = challengeClaims(fixtureChallenge(config))
    const other = createQuoteSigner({ secret: 'a-different-secret' })
    assert.equal(signer.verify(other.issue('nonce-1', claims), claims), false)
  })

  it('rejects anything that is not a signed quote id', () => {
    const claims = challengeClaims(fixtureChallenge(config))
    for (const bogus of ['', 'no-separator', '.mac-only', 'nonce-1.', 42, null, undefined, {}]) {
      assert.equal(signer.verify(bogus, claims), false)
    }
  })

  it('keeps the nonce recoverable even when it contains the separator', () => {
    const claims = challengeClaims(fixtureChallenge(config))
    const quoteId = signer.issue('dotted.nonce.here', claims)
    assert.equal(signer.verify(quoteId, claims), true)
  })
})

describe('challengeClaims', () => {
  it('length-prefixes fields so no two challenges can share claims', () => {
    // `a|b` as a product must not be able to read as two fields.
    const left = challengeClaims({ productId: 'a|b', resource: { url: '' }, requirements: {}, expiresAt: '' })
    const right = challengeClaims({ productId: 'a', resource: { url: 'b' }, requirements: {}, expiresAt: '' })
    assert.notEqual(left, right)
  })

  it('does not cover createdAt, which the site Quote shape cannot carry', () => {
    const challenge = fixtureChallenge(config, { now: () => 0 })
    assert.equal(
      challengeClaims(challenge),
      challengeClaims({ ...challenge, createdAt: '2020-01-01T00:00:00.000Z' }),
    )
  })

  it('survives a challenge missing every field, rather than throwing', () => {
    assert.equal(typeof challengeClaims({}), 'string')
    assert.equal(typeof challengeClaims(undefined), 'string')
  })
})
