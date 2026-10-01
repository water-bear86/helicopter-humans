import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  formatZec,
  MAX_ZATOSHIS,
  parseZatoshis,
  providerMinAcceptableZatoshis,
} from '../src/amounts.js'

describe('parseZatoshis', () => {
  it('accepts unsigned integer strings and BigInts', () => {
    assert.deepEqual(parseZatoshis('100000'), { ok: true, value: 100000n })
    assert.deepEqual(parseZatoshis(100000n), { ok: true, value: 100000n })
  })

  it('rejects every float and signed form a Number would swallow', () => {
    for (const bad of ['0.001', '1e5', '1.0', '+100000', '-100000', ' 100000', '100000 ', '0x10', '', '1_000']) {
      assert.equal(parseZatoshis(bad).ok, false, `expected ${JSON.stringify(bad)} to be rejected`)
    }
    assert.equal(parseZatoshis(100000).ok, false, 'a JS number is not an accepted money type')
  })

  it('rejects zero and anything past the u64 the facilitator parses into', () => {
    assert.equal(parseZatoshis('0').ok, false)
    assert.deepEqual(parseZatoshis(MAX_ZATOSHIS.toString()), { ok: true, value: MAX_ZATOSHIS })
    assert.equal(parseZatoshis((MAX_ZATOSHIS + 1n).toString()).ok, false)
  })
})

describe('providerMinAcceptableZatoshis', () => {
  it('matches the 0.5% tolerance in cipherpay-api src/api/x402.rs', () => {
    assert.equal(providerMinAcceptableZatoshis(100000n), 99500n)
    assert.equal(providerMinAcceptableZatoshis(1n), 0n)
  })
})

describe('formatZec', () => {
  it('renders zatoshis for display without floats', () => {
    assert.equal(formatZec(100000n), '0.001')
    assert.equal(formatZec(100000000n), '1')
    assert.equal(formatZec(100000001n), '1.00000001')
  })
})
