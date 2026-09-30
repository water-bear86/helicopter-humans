import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createPaymentChallenge as issueChallenge } from '../src/challenge.js'
import { resolveConfig } from '../src/config.js'
import { buildVerifyRequestBody, CipherPayFacilitator } from '../src/facilitator.js'
import { OUTCOME, REASON } from '../src/outcomes.js'
import { FIXTURE_API_KEY, FIXTURE_TXID, fixtureEnv, noSleep, scriptedFetch, fixtureSignQuoteId } from './helpers/fixtures.js'

const { config } = resolveConfig(fixtureEnv())

// Every challenge here is signed: `authorize` refuses an unsigned quote id.
const createPaymentChallenge = (args) => issueChallenge({ signQuoteId: fixtureSignQuoteId, ...args })
const challenge = createPaymentChallenge({
  config,
  resource: { url: 'https://example.test/api/v1/privacy-check' },
  now: () => 0,
})

function client(fetchImpl, overrides = {}) {
  return new CipherPayFacilitator({ config, fetch: fetchImpl, sleep: noSleep, ...overrides })
}

/**
 * Stand in for a hung request: settle only when the signal aborts. Checks
 * `aborted` first, because a signal can already be aborted by the time the
 * listener would be attached.
 */
function rejectOnAbort(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
  })
}

describe('buildVerifyRequestBody', () => {
  it('sends our own requirements as both paymentRequirements and accepted', () => {
    const body = buildVerifyRequestBody(challenge, FIXTURE_TXID)
    assert.equal(body.x402Version, 2)
    assert.deepEqual(body.paymentRequirements, body.paymentPayload.accepted)
    assert.equal(body.paymentRequirements.amount, '100000')
    assert.equal(body.paymentRequirements.payTo, config.payTo)
    assert.deepEqual(body.paymentPayload.payload, { txid: FIXTURE_TXID })
  })
})

describe('CipherPayFacilitator.verify', () => {
  it('posts to the v2 verify path with a bearer key and never leaks it into the outcome', async () => {
    const fetchImpl = scriptedFetch([{ status: 200, body: { isValid: true } }])
    const facilitator = client(fetchImpl)

    const outcome = await facilitator.verify({ challenge, txid: FIXTURE_TXID })

    assert.deepEqual(outcome, { kind: OUTCOME.VERIFIED })
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(fetchImpl.calls[0].url, 'http://127.0.0.1:59999/api/x402/v2/verify')
    assert.equal(fetchImpl.calls[0].init.method, 'POST')
    assert.equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${FIXTURE_API_KEY}`)
    assert.equal(fetchImpl.calls[0].init.redirect, 'error')
    assert.equal(JSON.stringify(outcome).includes(FIXTURE_API_KEY), false)
  })

  it('forwards our requirements, not a client-supplied set', async () => {
    const fetchImpl = scriptedFetch([{ status: 200, body: { isValid: true } }])
    await client(fetchImpl).verify({ challenge, txid: FIXTURE_TXID })
    const sent = JSON.parse(fetchImpl.calls[0].init.body)
    assert.equal(sent.paymentRequirements.amount, '100000')
    assert.equal(sent.paymentRequirements.network, 'zcash:mainnet')
  })

  it('reads invalid_transaction_state as pending, not as a rejected payment', async () => {
    const fetchImpl = scriptedFetch([
      { status: 200, body: { isValid: false, invalidReason: 'invalid_transaction_state' } },
    ])
    const outcome = await client(fetchImpl).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.kind, OUTCOME.PENDING)
    assert.equal(outcome.reason, REASON.TRANSACTION_NOT_VISIBLE)
  })

  it('reads insufficient_funds and invalid_payload as rejections', async () => {
    const underpaid = await client(
      scriptedFetch([{ status: 200, body: { isValid: false, invalidReason: 'insufficient_funds' } }]),
    ).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(underpaid.kind, OUTCOME.REJECTED)
    assert.equal(underpaid.reason, REASON.INSUFFICIENT_FUNDS)

    const notOurs = await client(
      scriptedFetch([{ status: 200, body: { isValid: false, invalidReason: 'invalid_payload' } }]),
    ).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(notOurs.kind, OUTCOME.REJECTED)
    assert.equal(notOurs.reason, REASON.NOT_ADDRESSED_TO_MERCHANT)
  })

  it('rejects on an unrecognised invalidReason rather than guessing', async () => {
    const outcome = await client(
      scriptedFetch([{ status: 200, body: { isValid: false, invalidReason: 'something_new' } }]),
    ).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.kind, OUTCOME.REJECTED)
    assert.equal(outcome.reason, REASON.FACILITATOR_REJECTED)
    assert.match(outcome.detail, /something_new/)
  })

  it('separates our 401 from a buyer payment problem and does not retry it', async () => {
    const fetchImpl = scriptedFetch([
      { status: 401, body: { type: 'https://cipherpay.app/errors/unauthorized', title: 'Unauthorized' }, headers: { 'content-type': 'application/problem+json' } },
    ])
    const outcome = await client(fetchImpl).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.MERCHANT_UNAUTHORIZED)
    assert.equal(outcome.operatorActionRequired, true)
    assert.equal(fetchImpl.calls.length, 1)
  })

  it('separates our unpaid merchant bill (402) from a buyer payment problem', async () => {
    const outcome = await client(
      scriptedFetch([{ status: 402, body: { type: 'https://cipherpay.app/errors/merchant-billing-blocked' } }]),
    ).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.MERCHANT_BILLING_BLOCKED)
    assert.equal(outcome.operatorActionRequired, true)
    assert.match(outcome.detail, /was not assessed/)
  })

  it('treats a 400 as our bug, not the buyer’s', async () => {
    const outcome = await client(
      scriptedFetch([{ status: 400, body: { type: 'https://cipherpay.app/errors/invalid-payload' } }]),
    ).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.FACILITATOR_BAD_RESPONSE)
    assert.match(outcome.detail, /invalid-payload/)
  })

  it('retries the same txid on 503 and succeeds without asking for a second payment', async () => {
    const fetchImpl = scriptedFetch([
      { status: 503, body: {} },
      { status: 200, body: { isValid: true } },
    ])
    const outcome = await client(fetchImpl).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.kind, OUTCOME.VERIFIED)
    assert.equal(fetchImpl.calls.length, 2)
    const txids = fetchImpl.calls.map((c) => JSON.parse(c.init.body).paymentPayload.payload.txid)
    assert.deepEqual(txids, [FIXTURE_TXID, FIXTURE_TXID])
  })

  it('bounds retries and reports the facilitator unavailable', async () => {
    const fetchImpl = scriptedFetch([{ status: 500, body: {} }])
    const outcome = await client(fetchImpl, { maxAttempts: 3 }).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.FACILITATOR_UNAVAILABLE)
    assert.equal(fetchImpl.calls.length, 3)
  })

  it('retries a transport error, bounded', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      throw new TypeError('fetch failed')
    }
    const outcome = await client(fetchImpl, { maxAttempts: 2 }).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.reason, REASON.FACILITATOR_UNAVAILABLE)
    assert.equal(calls, 2)
  })

  it('does not retry a response it cannot parse', async () => {
    const fetchImpl = scriptedFetch([{ status: 200, body: 'not json at all' }])
    const outcome = await client(fetchImpl).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.reason, REASON.FACILITATOR_BAD_RESPONSE)
    assert.equal(fetchImpl.calls.length, 1)
  })

  it('does not treat a missing isValid as success', async () => {
    const outcome = await client(scriptedFetch([{ status: 200, body: { ok: 'yes' } }])).verify({
      challenge,
      txid: FIXTURE_TXID,
    })
    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.FACILITATOR_BAD_RESPONSE)
  })

  it('refuses a response body larger than the cap', async () => {
    const fetchImpl = scriptedFetch([
      { status: 200, body: JSON.stringify({ isValid: true, pad: 'x'.repeat(5000) }) },
    ])
    const outcome = await client(fetchImpl, { maxResponseBytes: 256 }).verify({ challenge, txid: FIXTURE_TXID })
    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.FACILITATOR_BAD_RESPONSE)
  })

  it('times out a hung attempt and reports it as a timeout', async () => {
    let calls = 0
    const fetchImpl = (_url, init) => {
      calls += 1
      return rejectOnAbort(init.signal)
    }
    const outcome = await client(fetchImpl, { attemptTimeoutMs: 15, maxAttempts: 2 }).verify({
      challenge,
      txid: FIXTURE_TXID,
    })
    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.FACILITATOR_UNAVAILABLE)
    assert.match(outcome.detail, /timed out/)
    assert.equal(calls, 2)
  })

  it('stops attempting the moment the caller aborts', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchImpl = (_url, init) => {
      calls += 1
      controller.abort()
      return rejectOnAbort(init.signal)
    }
    const outcome = await client(fetchImpl, { maxAttempts: 5 }).verify({
      challenge,
      txid: FIXTURE_TXID,
      signal: controller.signal,
    })
    assert.equal(outcome.reason, REASON.CANCELLED)
    assert.equal(calls, 1, 'cancellation must stop further attempts')
  })

  it('does not attempt at all when the caller signal is already aborted', async () => {
    let calls = 0
    const outcome = await client(async () => {
      calls += 1
      return new Response('{}')
    }).verify({ challenge, txid: FIXTURE_TXID, signal: AbortSignal.abort() })
    assert.equal(outcome.reason, REASON.CANCELLED)
    assert.equal(calls, 0)
  })

  it('stops during backoff when the caller aborts', async () => {
    const controller = new AbortController()
    const fetchImpl = scriptedFetch([{ status: 503, body: {} }])
    const facilitator = new CipherPayFacilitator({
      config,
      fetch: fetchImpl,
      maxAttempts: 4,
      sleep: async () => {
        controller.abort()
        throw new Error('aborted')
      },
    })
    const outcome = await facilitator.verify({ challenge, txid: FIXTURE_TXID, signal: controller.signal })
    assert.equal(outcome.reason, REASON.CANCELLED)
    assert.equal(fetchImpl.calls.length, 1)
  })

  it('rejects a construction without a fetch implementation or a sane attempt budget', () => {
    assert.throws(() => new CipherPayFacilitator({ config, fetch: null }), TypeError)
    assert.throws(() => new CipherPayFacilitator({ config, fetch: () => {}, maxAttempts: 0 }), TypeError)
  })
})
