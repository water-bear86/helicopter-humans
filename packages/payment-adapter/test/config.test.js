import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { ENV_KEYS, HOSTED_FACILITATOR_URL, resolveConfig } from '../src/config.js'
import { FIXTURE_PAYTO_UA, fixtureEnv } from './helpers/fixtures.js'

describe('resolveConfig', () => {
  it('is disabled with an empty environment and names every missing variable', () => {
    const resolved = resolveConfig({})
    assert.equal(resolved.mode, 'disabled')
    assert.equal(resolved.config, undefined)
    const joined = resolved.problems.join(' ')
    for (const key of [ENV_KEYS.apiKey, ENV_KEYS.payTo, ENV_KEYS.priceZatoshis]) {
      assert.match(joined, new RegExp(key))
    }
  })

  it('treats blank and whitespace-only values as absent', () => {
    const resolved = resolveConfig(fixtureEnv({ CIPHERPAY_API_KEY: '   ' }))
    assert.equal(resolved.mode, 'disabled')
    assert.match(resolved.problems.join(' '), /CIPHERPAY_API_KEY is not set/)
  })

  it('refuses a transparent payTo, because a transparent transfer is public', () => {
    const resolved = resolveConfig(
      fixtureEnv({ ZCASH_PAYTO_UA: 't1KsmsCKNqQrxNVpVTkJdBmNVQCtyNMfDJP' }),
    )
    assert.equal(resolved.mode, 'disabled')
    assert.match(resolved.problems.join(' '), /transparent/)
  })

  it('refuses a bare Sapling address and anything that is not a unified address', () => {
    for (const payTo of ['zs1abcdefghijklmnopqrstuvwxyz0123456789', 'not-an-address', 'u1short']) {
      assert.equal(resolveConfig(fixtureEnv({ ZCASH_PAYTO_UA: payTo })).mode, 'disabled')
    }
  })

  it('refuses a float or zero price', () => {
    for (const price of ['0.001', '0', '1e5']) {
      const resolved = resolveConfig(fixtureEnv({ ZCASH_PRICE_ZATOSHIS: price }))
      assert.equal(resolved.mode, 'disabled', `expected ${price} to disable the adapter`)
      assert.match(resolved.problems.join(' '), /ZCASH_PRICE_ZATOSHIS/)
    }
  })

  it('refuses zcash:testnet, which the hosted facilitator does not advertise', () => {
    const resolved = resolveConfig(fixtureEnv({ CIPHERPAY_NETWORK: 'zcash:testnet' }))
    assert.equal(resolved.mode, 'disabled')
    assert.match(resolved.problems.join(' '), /advertises only "zcash:mainnet"/)
  })

  it('refuses plain http unless the host is loopback', () => {
    assert.equal(
      resolveConfig(fixtureEnv({ CIPHERPAY_FACILITATOR_URL: 'http://api.cipherpay.app' })).mode,
      'disabled',
    )
    assert.equal(resolveConfig(fixtureEnv()).mode, 'test')
  })

  it('reports live mode only for the hosted facilitator', () => {
    const live = resolveConfig(
      fixtureEnv({ CIPHERPAY_FACILITATOR_URL: HOSTED_FACILITATOR_URL }),
    )
    assert.equal(live.mode, 'live')
    assert.equal(live.config.hostedFacilitator, true)
    assert.equal(live.config.payTo, FIXTURE_PAYTO_UA)
    assert.equal(live.config.priceZatoshis, 100000n)
  })

  it('defaults the facilitator URL and network when they are absent', () => {
    const resolved = resolveConfig({
      CIPHERPAY_API_KEY: 'fixture-not-a-real-key',
      ZCASH_PAYTO_UA: FIXTURE_PAYTO_UA,
      ZCASH_PRICE_ZATOSHIS: '100000',
    })
    assert.equal(resolved.mode, 'live')
    assert.equal(resolved.config.facilitatorUrl, HOSTED_FACILITATOR_URL)
    assert.equal(resolved.config.network, 'zcash:mainnet')
  })

  it('strips a trailing slash so the verify path cannot double up', () => {
    const resolved = resolveConfig(
      fixtureEnv({ CIPHERPAY_FACILITATOR_URL: 'http://127.0.0.1:59999/' }),
    )
    assert.equal(resolved.config.facilitatorUrl, 'http://127.0.0.1:59999')
  })
})
