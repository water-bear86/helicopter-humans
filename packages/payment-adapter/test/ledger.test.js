import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { LedgerContractError } from '../src/errors.js'
import {
  assertReceiptLedger,
  CLAIM,
  InMemoryReceiptLedger,
  merchantScopeFromApiKey,
  receiptKey,
  RECORD_STATE,
} from '../src/ledger.js'
import { FIXTURE_API_KEY, FIXTURE_TXID } from './helpers/fixtures.js'

const base = {
  network: 'zcash:mainnet',
  merchantId: 'merchant-fixture',
  txid: FIXTURE_TXID,
  amountZatoshis: '100000',
}

describe('receiptKey', () => {
  it('scopes by network, merchant and txid, and normalises txid case', () => {
    assert.equal(
      receiptKey({ ...base, txid: FIXTURE_TXID.toUpperCase() }),
      `zcash:mainnet|merchant-fixture|${FIXTURE_TXID}`,
    )
  })

  it('keeps the same txid distinct across networks and merchants', () => {
    assert.notEqual(receiptKey(base), receiptKey({ ...base, network: 'zcash:other' }))
    assert.notEqual(receiptKey(base), receiptKey({ ...base, merchantId: 'someone-else' }))
  })
})

describe('merchantScopeFromApiKey', () => {
  it('is stable and does not contain the key', () => {
    const scope = merchantScopeFromApiKey(FIXTURE_API_KEY)
    assert.equal(scope, merchantScopeFromApiKey(FIXTURE_API_KEY))
    assert.equal(scope.length, 32)
    assert.equal(scope.includes(FIXTURE_API_KEY), false)
    assert.notEqual(scope, merchantScopeFromApiKey(`${FIXTURE_API_KEY}-rotated`))
  })
})

describe('assertReceiptLedger', () => {
  it('requires the full contract, including the durability declaration', () => {
    assert.throws(() => assertReceiptLedger(undefined), LedgerContractError)
    assert.throws(() => assertReceiptLedger({}), LedgerContractError)
    assert.throws(
      () => assertReceiptLedger({ claim() {}, settle() {}, get() {} }),
      /durable: boolean/,
    )
    const ledger = new InMemoryReceiptLedger()
    assert.equal(assertReceiptLedger(ledger), ledger)
  })
})

describe('InMemoryReceiptLedger', () => {
  it('declares itself non-durable so the adapter can fail closed', () => {
    assert.equal(new InMemoryReceiptLedger().durable, false)
  })

  it('grants the first claimant and recognises a same-request retry', async () => {
    const ledger = new InMemoryReceiptLedger()
    const first = await ledger.claim({ ...base, requestId: 'req-1' })
    assert.equal(first.status, CLAIM.ACQUIRED)
    assert.equal(first.record.state, RECORD_STATE.CLAIMED)

    const retry = await ledger.claim({ ...base, requestId: 'req-1' })
    assert.equal(retry.status, CLAIM.OWNED)
  })

  it('refuses a second request id for the same txid', async () => {
    const ledger = new InMemoryReceiptLedger()
    await ledger.claim({ ...base, requestId: 'req-1' })
    const other = await ledger.claim({ ...base, requestId: 'req-2' })
    assert.equal(other.status, CLAIM.TAKEN)
    assert.equal(other.record.requestId, 'req-1')
  })

  it('refuses the same request re-presented at a different price tier', async () => {
    const ledger = new InMemoryReceiptLedger()
    await ledger.claim({ ...base, requestId: 'req-1', amountZatoshis: '100000' })
    const upsell = await ledger.claim({ ...base, requestId: 'req-1', amountZatoshis: '50000000' })
    assert.equal(upsell.status, CLAIM.TAKEN)
  })

  it('serialises concurrent claimants so exactly one acquires', async () => {
    const ledger = new InMemoryReceiptLedger()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => ledger.claim({ ...base, requestId: `req-${i}` })),
    )
    assert.equal(results.filter((r) => r.status === CLAIM.ACQUIRED).length, 1)
    assert.equal(results.filter((r) => r.status === CLAIM.TAKEN).length, 7)
    assert.equal(ledger.size(), 1)
  })

  it('returns the stored outcome after settling', async () => {
    const ledger = new InMemoryReceiptLedger()
    await ledger.claim({ ...base, requestId: 'req-1' })
    const settled = await ledger.settle({
      ...base,
      requestId: 'req-1',
      state: RECORD_STATE.GRANTED,
      outcome: { reason: null, detail: 'verified by CipherPay' },
    })
    assert.equal(settled.state, RECORD_STATE.GRANTED)

    const retry = await ledger.claim({ ...base, requestId: 'req-1' })
    assert.equal(retry.status, CLAIM.OWNED)
    assert.equal(retry.record.state, RECORD_STATE.GRANTED)
    assert.deepEqual(retry.record.outcome, { reason: null, detail: 'verified by CipherPay' })
  })

  it('lets only the owning request settle a receipt', async () => {
    const ledger = new InMemoryReceiptLedger()
    await ledger.claim({ ...base, requestId: 'req-1' })
    await assert.rejects(
      ledger.settle({ ...base, requestId: 'req-2', state: RECORD_STATE.GRANTED, outcome: { reason: null, detail: 'x' } }),
      LedgerContractError,
    )
  })

  it('refuses to settle a receipt that was never claimed', async () => {
    const ledger = new InMemoryReceiptLedger()
    await assert.rejects(
      ledger.settle({ ...base, requestId: 'req-1', state: RECORD_STATE.GRANTED, outcome: { reason: null, detail: 'x' } }),
      /unclaimed receipt/,
    )
  })

  it('reads a record back by key, or undefined', async () => {
    const ledger = new InMemoryReceiptLedger()
    assert.equal(await ledger.get(base), undefined)
    await ledger.claim({ ...base, requestId: 'req-1' })
    assert.equal((await ledger.get(base)).requestId, 'req-1')
  })
})
