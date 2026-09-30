import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  ADAPTER_ID,
  createPaymentAdapter,
  INTEGRATION_BLOCKERS,
  PRIVACY_NOTE,
} from '../src/adapter.js'
import { AdapterConfigurationError, UnsafeLedgerError } from '../src/errors.js'
import { CLAIM, InMemoryReceiptLedger, RECORD_STATE } from '../src/ledger.js'
import { OUTCOME, REASON } from '../src/outcomes.js'
import {
  FIXTURE_API_KEY,
  FIXTURE_PAYTO_UA,
  FIXTURE_TXID,
  fixtureEnv,
  OTHER_FIXTURE_TXID,
  paymentSignature,
  stubFacilitator,
} from './helpers/fixtures.js'

const RESOURCE = { url: 'https://example.test/api/v1/privacy-check', description: 'One shielded privacy check' }

/**
 * A durable-declaring ledger backed by the in-memory one, so the happy paths
 * do not need the `allowEphemeralLedger` escape hatch. Durable in name only:
 * it exists to exercise the adapter, never to store money in production.
 */
function fakeDurableLedger(options = {}) {
  const inner = new InMemoryReceiptLedger(options)
  return {
    durable: true,
    claim: (c) => inner.claim(c),
    settle: (s) => inner.settle(s),
    get: (k) => inner.get(k),
    size: () => inner.size(),
  }
}

function build({ facilitator, ledger = fakeDurableLedger(), env = fixtureEnv(), ...rest } = {}) {
  return createPaymentAdapter({
    env,
    ledger,
    facilitator: facilitator ?? stubFacilitator({ kind: OUTCOME.VERIFIED }),
    now: () => 1_000_000,
    ...rest,
  })
}

async function authorizeWith(adapter, options = {}) {
  const { txid = FIXTURE_TXID, requestId, challenge } = options
  const used = challenge ?? adapter.createChallenge({ resource: RESOURCE })
  // `header` present but undefined means "send no header at all"; absent
  // means "send a well-formed one for this challenge".
  const header = 'header' in options ? options.header : paymentSignature(used, { txid })
  return {
    challenge: used,
    outcome: await adapter.authorize({
      challenge: used,
      paymentSignatureHeader: header,
      requestId,
    }),
  }
}

describe('adapter identity and honesty', () => {
  it('never reports itself ready for a live paid route while blockers stand', () => {
    const adapter = build()
    assert.equal(adapter.id, ADAPTER_ID)
    assert.equal(adapter.readyForLivePaidRoute, false)
    assert.ok(INTEGRATION_BLOCKERS.length > 0)
    assert.ok(INTEGRATION_BLOCKERS.some((b) => b.id === 'no_payer_binding'))
  })

  it('states a privacy note that claims only what 49TH-12 verified', () => {
    assert.match(PRIVACY_NOTE, /shielded ZEC/)
    assert.match(PRIVACY_NOTE, /read-only viewing key/)
    assert.match(PRIVACY_NOTE, /IP address/)
    assert.match(PRIVACY_NOTE, /no automatic refund/)
    for (const overclaim of [/reveals nothing/i, /nobody can see/i, /anonymous/i, /swap/i]) {
      assert.doesNotMatch(PRIVACY_NOTE, overclaim)
    }
  })

  it('reports test mode for a loopback fixture facilitator, never "provider testnet"', () => {
    const adapter = build()
    assert.equal(adapter.mode, 'test')
    assert.equal(adapter.network, 'zcash:mainnet')
    assert.equal(adapter.priceZec, '0.001')
  })

  it('does not expose the API key on the adapter surface', () => {
    const adapter = build()
    assert.equal(JSON.stringify(adapter).includes(FIXTURE_API_KEY), false)
    assert.equal(adapter.merchantId.includes(FIXTURE_API_KEY), false)
  })
})

describe('unconfigured and unsafe storage', () => {
  it('is disabled with no configuration and grants nothing', async () => {
    const adapter = createPaymentAdapter({ env: {}, ledger: fakeDurableLedger() })
    assert.equal(adapter.mode, 'disabled')
    assert.ok(adapter.configProblems.length > 0)

    const outcome = await adapter.authorize({ challenge: {}, paymentSignatureHeader: 'anything' })
    assert.equal(outcome.kind, OUTCOME.DISABLED)
    assert.equal(outcome.httpStatus, 503)
    assert.deepEqual(outcome.headers, {})

    assert.throws(() => adapter.createChallenge({ resource: RESOURCE }), AdapterConfigurationError)
    await assert.rejects(adapter.quote({ productId: 'x' }), AdapterConfigurationError)
    assert.deepEqual(await adapter.settle({ quoteId: 'q1' }, FIXTURE_TXID), {
      status: 'failed',
      quoteId: 'q1',
      reason: 'Payments are not enabled on this deployment.',
      retryable: false,
    })
  })

  it('fails closed when the receipt ledger is not durable', () => {
    assert.throws(
      () => createPaymentAdapter({ env: fixtureEnv(), ledger: new InMemoryReceiptLedger() }),
      UnsafeLedgerError,
    )
    assert.throws(
      () => createPaymentAdapter({ env: fixtureEnv(), ledger: new InMemoryReceiptLedger() }),
      /two instances would each grant a resource for the same txid/,
    )
  })

  it('allows an ephemeral ledger only behind an explicit opt-in, and warns', () => {
    const adapter = createPaymentAdapter({
      env: fixtureEnv(),
      ledger: new InMemoryReceiptLedger(),
      allowEphemeralLedger: true,
      facilitator: stubFacilitator({ kind: OUTCOME.VERIFIED }),
    })
    assert.match(adapter.warnings.join(' '), /ephemeral receipt ledger/)
  })

  it('requires a ledger that declares the contract at all', () => {
    assert.throws(() => createPaymentAdapter({ env: fixtureEnv() }), /receipt ledger is required/)
    assert.throws(
      () => createPaymentAdapter({ env: fixtureEnv(), ledger: { claim() {}, settle() {}, get() {} } }),
      /durable: boolean/,
    )
  })
})

describe('challenge issuance', () => {
  it('offers a challenge and the PAYMENT-REQUIRED header when no proof is presented', async () => {
    const adapter = build()
    const { challenge, outcome } = await authorizeWith(adapter, { header: undefined })

    assert.equal(outcome.kind, OUTCOME.PAYMENT_REQUIRED)
    assert.equal(outcome.httpStatus, 402)
    assert.ok(outcome.headers['PAYMENT-REQUIRED'])
    const decoded = JSON.parse(Buffer.from(outcome.headers['PAYMENT-REQUIRED'], 'base64').toString('utf8'))
    assert.equal(decoded.accepts[0].amount, '100000')
    assert.equal(decoded.accepts[0].payTo, FIXTURE_PAYTO_UA)
    assert.equal(outcome.body.accepts[0].payTo, challenge.requirements.payTo)
  })

  it('refuses a challenge whose terms drifted from configuration, without reserving the txid', async () => {
    const ledger = fakeDurableLedger()
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ ledger, facilitator })
    const challenge = adapter.createChallenge({ resource: RESOURCE })

    for (const tampered of [
      { ...challenge.requirements, amount: '1' },
      { ...challenge.requirements, payTo: 'u1attacker' },
      { ...challenge.requirements, network: 'zcash:testnet' },
      // Pinned here as well as in the envelope comparison: the facilitator
      // raises on an unknown scheme, and it used to do so after the claim.
      { ...challenge.requirements, scheme: 'bogus' },
      { ...challenge.requirements, asset: 'BTC' },
    ]) {
      const outcome = await adapter.authorize({
        challenge: { ...challenge, requirements: tampered },
        paymentSignatureHeader: paymentSignature({ ...challenge, requirements: tampered }),
      })
      assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
      assert.equal(outcome.reason, REASON.CHALLENGE_CONFIG_DRIFT)
      assert.equal(outcome.operatorFacing, true)
      assert.equal(outcome.operatorActionRequired, true)
      assert.equal(outcome.httpStatus, 503)
    }

    // An outcome, not an exception -- and nothing reserved, nothing verified.
    assert.equal(ledger.size(), 0)
    assert.equal(facilitator.calls.length, 0)
  })

  it('still rejects a challenge that is not an object at all', async () => {
    const adapter = build()
    await assert.rejects(adapter.authorize({ challenge: null }), AdapterConfigurationError)
    await assert.rejects(adapter.authorize({ challenge: {} }), AdapterConfigurationError)
  })
})

describe('only quotes this server issued are honoured', () => {
  it('refuses a challenge whose quote id does not carry our mac', async () => {
    const ledger = fakeDurableLedger()
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ ledger, facilitator })
    const challenge = adapter.createChallenge({ resource: RESOURCE })

    for (const forged of [
      { ...challenge, quoteId: 'not-issued-by-quote' },
      { ...challenge, quoteId: `${challenge.quoteId}x` },
      // Correctly signed, but for terms that are no longer these ones.
      { ...challenge, expiresAt: '2099-01-01T00:00:00.000Z' },
      { ...challenge, resource: { ...challenge.resource, url: 'https://example.test/other' } },
      { ...challenge, productId: 'founding-pass' },
    ]) {
      const outcome = await adapter.authorize({
        challenge: forged,
        paymentSignatureHeader: paymentSignature(forged),
      })
      assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
      assert.equal(outcome.reason, REASON.QUOTE_NOT_ISSUED)
      assert.equal(outcome.operatorFacing, true)
    }

    assert.equal(ledger.size(), 0)
    assert.equal(facilitator.calls.length, 0)
  })

  it('accepts a different signing secret only for quotes signed with it', async () => {
    const mine = build({ quoteSigningSecret: 'secret-a' })
    const theirs = build({ quoteSigningSecret: 'secret-b' })
    const challenge = theirs.createChallenge({ resource: RESOURCE })

    const outcome = await mine.authorize({
      challenge,
      paymentSignatureHeader: paymentSignature(challenge),
    })
    assert.equal(outcome.reason, REASON.QUOTE_NOT_ISSUED)

    const ours = await theirs.authorize({
      challenge,
      paymentSignatureHeader: paymentSignature(challenge),
    })
    assert.equal(ours.kind, OUTCOME.VERIFIED)
  })
})

describe('envelope failures never re-quote a payment that may already be sent', () => {
  it('rejects a malformed header without offering a fresh challenge', async () => {
    const adapter = build()
    const { outcome } = await authorizeWith(adapter, { header: 'not base64!!' })
    assert.equal(outcome.kind, OUTCOME.REJECTED)
    assert.equal(outcome.reason, REASON.MALFORMED_PAYMENT_HEADER)
    assert.equal(outcome.headers['PAYMENT-REQUIRED'], undefined)
    assert.equal(outcome.body.retryWithSamePayment, true)
  })

  it('rejects an oversized header, a wrong x402 version and a bad txid', async () => {
    const adapter = build()
    const challenge = adapter.createChallenge({ resource: RESOURCE })

    const big = await adapter.authorize({ challenge, paymentSignatureHeader: 'A'.repeat(20000) })
    assert.equal(big.reason, REASON.HEADER_TOO_LARGE)

    const v1 = await adapter.authorize({
      challenge,
      paymentSignatureHeader: paymentSignature(challenge, { x402Version: 1 }),
    })
    assert.equal(v1.reason, REASON.UNSUPPORTED_X402_VERSION)

    const badTxid = await adapter.authorize({
      challenge,
      paymentSignatureHeader: paymentSignature(challenge, { txid: 'nope' }),
    })
    assert.equal(badTxid.reason, REASON.INVALID_TXID)

    for (const outcome of [big, v1, badTxid]) {
      assert.equal(outcome.kind, OUTCOME.REJECTED)
      assert.equal(outcome.headers['PAYMENT-REQUIRED'], undefined)
    }
  })

  it('rejects changed requirements without calling the facilitator', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })
    const challenge = adapter.createChallenge({ resource: RESOURCE })

    const outcome = await adapter.authorize({
      challenge,
      paymentSignatureHeader: paymentSignature(challenge, {
        accepted: { ...challenge.requirements, amount: '1' },
      }),
    })

    assert.equal(outcome.kind, OUTCOME.REJECTED)
    assert.equal(outcome.reason, REASON.REQUIREMENTS_MISMATCH)
    assert.deepEqual(outcome.mismatches, ['amount'])
    assert.equal(facilitator.calls.length, 0, 'a mismatched quote must not reach the facilitator')
  })

  it('rejects an expired quote without calling the facilitator', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    let clock = 1_000_000
    const adapter = createPaymentAdapter({
      env: fixtureEnv(),
      ledger: fakeDurableLedger(),
      facilitator,
      now: () => clock,
    })
    const challenge = adapter.createChallenge({ resource: RESOURCE })
    clock += 300_001

    const outcome = await adapter.authorize({
      challenge,
      paymentSignatureHeader: paymentSignature(challenge),
    })
    assert.equal(outcome.kind, OUTCOME.REJECTED)
    assert.equal(outcome.reason, REASON.QUOTE_EXPIRED)
    assert.equal(facilitator.calls.length, 0)
  })
})

describe('verified payment', () => {
  it('grants once, emits PAYMENT-RESPONSE and records the receipt', async () => {
    const ledger = fakeDurableLedger()
    const adapter = build({ ledger })
    const { challenge, outcome } = await authorizeWith(adapter)

    assert.equal(outcome.kind, OUTCOME.VERIFIED)
    assert.equal(outcome.httpStatus, 200)
    assert.equal(outcome.replay, false)
    assert.equal(outcome.txid, FIXTURE_TXID)
    const decoded = JSON.parse(Buffer.from(outcome.headers['PAYMENT-RESPONSE'], 'base64').toString('utf8'))
    assert.deepEqual(decoded, { success: true, txid: FIXTURE_TXID, network: 'zcash:mainnet' })

    const record = await ledger.get({ network: 'zcash:mainnet', merchantId: adapter.merchantId, txid: FIXTURE_TXID })
    assert.equal(record.state, RECORD_STATE.GRANTED)
    assert.equal(record.requestId, challenge.quoteId)
    assert.equal(record.amountZatoshis, '100000')
  })

  it('accepts a mixed-case txid and stores it once', async () => {
    const ledger = fakeDurableLedger()
    const adapter = build({ ledger })
    const { outcome } = await authorizeWith(adapter, { txid: FIXTURE_TXID.toUpperCase() })
    assert.equal(outcome.kind, OUTCOME.VERIFIED)
    assert.equal(outcome.txid, FIXTURE_TXID)
    assert.equal(ledger.size(), 1)
  })

  it('sends the facilitator our challenge, with the client txid', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })
    const { challenge } = await authorizeWith(adapter)
    assert.equal(facilitator.calls.length, 1)
    assert.equal(facilitator.calls[0].txid, FIXTURE_TXID)
    assert.equal(facilitator.calls[0].challenge.requirements.amount, challenge.requirements.amount)
  })
})

describe('replay, idempotency and concurrency', () => {
  it('returns the same stored result when the same request retries', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })
    const challenge = adapter.createChallenge({ resource: RESOURCE })
    const header = paymentSignature(challenge)

    const first = await adapter.authorize({ challenge, paymentSignatureHeader: header })
    const second = await adapter.authorize({ challenge, paymentSignatureHeader: header })

    assert.equal(first.kind, OUTCOME.VERIFIED)
    assert.equal(second.kind, OUTCOME.VERIFIED)
    assert.equal(first.replay, false)
    assert.equal(second.replay, true)
    assert.equal(facilitator.calls.length, 1, 'a same-request retry must not re-verify')
  })

  it('refuses a replayed txid presented for a different request', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })

    const first = await authorizeWith(adapter)
    assert.equal(first.outcome.kind, OUTCOME.VERIFIED)

    const second = await authorizeWith(adapter)
    assert.equal(second.outcome.kind, OUTCOME.REJECTED)
    assert.equal(second.outcome.reason, REASON.TXID_ALREADY_CLAIMED)
    assert.equal(second.outcome.httpStatus, 402)
    assert.notEqual(first.challenge.quoteId, second.challenge.quoteId)
  })

  it('grants exactly one of many concurrent claimants for the same txid', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => {
        const challenge = adapter.createChallenge({ resource: RESOURCE })
        return adapter.authorize({ challenge, paymentSignatureHeader: paymentSignature(challenge) })
      }),
    )

    assert.equal(outcomes.filter((o) => o.kind === OUTCOME.VERIFIED).length, 1)
    assert.equal(
      outcomes.filter((o) => o.reason === REASON.TXID_ALREADY_CLAIMED).length,
      5,
    )
    assert.equal(facilitator.calls.length, 1)
  })

  it('does not let a second price tier reuse a granted txid', async () => {
    const ledger = fakeDurableLedger()
    const cheap = build({ ledger })
    await authorizeWith(cheap)

    const pricey = createPaymentAdapter({
      env: fixtureEnv({ ZCASH_PRICE_ZATOSHIS: '50000000' }),
      ledger,
      facilitator: stubFacilitator({ kind: OUTCOME.VERIFIED }),
      now: () => 1_000_000,
      merchantId: cheap.merchantId,
    })
    const { outcome } = await authorizeWith(pricey)
    assert.equal(outcome.reason, REASON.TXID_ALREADY_CLAIMED)
  })

  it('replays a stored rejection instead of re-verifying it', async () => {
    const facilitator = stubFacilitator({
      kind: OUTCOME.REJECTED,
      reason: REASON.INSUFFICIENT_FUNDS,
      detail: 'underpaid',
      operatorActionRequired: false,
    })
    const adapter = build({ facilitator })
    const challenge = adapter.createChallenge({ resource: RESOURCE })
    const header = paymentSignature(challenge)

    const first = await adapter.authorize({ challenge, paymentSignatureHeader: header })
    const second = await adapter.authorize({ challenge, paymentSignatureHeader: header })

    assert.equal(first.reason, REASON.INSUFFICIENT_FUNDS)
    assert.equal(second.reason, REASON.INSUFFICIENT_FUNDS)
    assert.equal(second.replay, true)
    assert.equal(facilitator.calls.length, 1)
  })

  it('keeps distinct txids independent', async () => {
    const ledger = fakeDurableLedger()
    const adapter = build({ ledger })
    const a = await authorizeWith(adapter, { txid: FIXTURE_TXID })
    const b = await authorizeWith(adapter, { txid: OTHER_FIXTURE_TXID })
    assert.equal(a.outcome.kind, OUTCOME.VERIFIED)
    assert.equal(b.outcome.kind, OUTCOME.VERIFIED)
    assert.equal(ledger.size(), 2)
  })
})

describe('pending, rejected and upstream outcomes', () => {
  it('answers 202 for a payment the facilitator cannot see yet, and never re-quotes', async () => {
    const adapter = build({
      facilitator: stubFacilitator({
        kind: OUTCOME.PENDING,
        reason: REASON.TRANSACTION_NOT_VISIBLE,
        detail: 'not visible yet',
        operatorActionRequired: false,
      }),
    })
    const { outcome } = await authorizeWith(adapter)

    assert.equal(outcome.kind, OUTCOME.PENDING)
    assert.equal(outcome.httpStatus, 202)
    assert.equal(outcome.headers['Retry-After'], '15')
    assert.equal(outcome.headers['PAYMENT-REQUIRED'], undefined, 'never invite a second transfer')
    assert.equal(outcome.body.retryWithSamePayment, true)
    assert.match(outcome.buyerMessage, /do not send a second payment/)
  })

  it('lets the same request retry a pending payment until it verifies', async () => {
    const facilitator = stubFacilitator([
      { kind: OUTCOME.PENDING, reason: REASON.TRANSACTION_NOT_VISIBLE, detail: 'not yet', operatorActionRequired: false },
      { kind: OUTCOME.VERIFIED },
    ])
    const adapter = build({ facilitator })
    const challenge = adapter.createChallenge({ resource: RESOURCE })
    const header = paymentSignature(challenge)

    assert.equal((await adapter.authorize({ challenge, paymentSignatureHeader: header })).kind, OUTCOME.PENDING)
    const second = await adapter.authorize({ challenge, paymentSignatureHeader: header })
    assert.equal(second.kind, OUTCOME.VERIFIED)
    assert.equal(facilitator.calls.length, 2)
  })

  it('keeps a pending txid reserved against another claimant', async () => {
    const adapter = build({
      facilitator: stubFacilitator({ kind: OUTCOME.PENDING, reason: REASON.TRANSACTION_NOT_VISIBLE, detail: 'x', operatorActionRequired: false }),
    })
    await authorizeWith(adapter)
    const { outcome } = await authorizeWith(adapter)
    assert.equal(outcome.reason, REASON.TXID_ALREADY_CLAIMED)
  })

  it('reports an underpayment as a buyer-facing rejection', async () => {
    const adapter = build({
      facilitator: stubFacilitator({ kind: OUTCOME.REJECTED, reason: REASON.INSUFFICIENT_FUNDS, detail: 'underpaid', operatorActionRequired: false }),
    })
    const { outcome } = await authorizeWith(adapter)
    assert.equal(outcome.kind, OUTCOME.REJECTED)
    assert.equal(outcome.httpStatus, 402)
    assert.equal(outcome.operatorFacing, false)
    assert.match(outcome.buyerMessage, /does not cover this quote/)
  })

  it('does not blame the buyer for our expired key or unpaid merchant bill', async () => {
    for (const reason of [REASON.MERCHANT_UNAUTHORIZED, REASON.MERCHANT_BILLING_BLOCKED]) {
      const adapter = build({
        facilitator: stubFacilitator({ kind: OUTCOME.UPSTREAM_ERROR, reason, detail: 'our problem', operatorActionRequired: true }),
      })
      const { outcome } = await authorizeWith(adapter)
      assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
      assert.equal(outcome.httpStatus, 503)
      assert.equal(outcome.operatorFacing, true)
      assert.equal(outcome.operatorActionRequired, true)
      assert.match(outcome.buyerMessage, /Your payment was not assessed/)
      assert.doesNotMatch(outcome.buyerMessage, /rejected|invalid|insufficient/i)
    }
  })

  it('answers 504 for a verification timeout and keeps the proof retryable', async () => {
    const adapter = build({
      facilitator: stubFacilitator({ kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.FACILITATOR_TIMEOUT, detail: 'timed out', operatorActionRequired: false }),
    })
    const { outcome } = await authorizeWith(adapter)
    assert.equal(outcome.httpStatus, 504)
    assert.equal(outcome.retrySameProofSafe, true)
    assert.equal(outcome.body.retryWithSamePayment, true)
  })

  it('reports cancellation without marking the proof as reusable elsewhere', async () => {
    const adapter = build({
      facilitator: stubFacilitator({ kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.CANCELLED, detail: 'cancelled', operatorActionRequired: false }),
    })
    const { outcome } = await authorizeWith(adapter)
    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.CANCELLED)
    assert.equal(outcome.retrySameProofSafe, false)
  })

  it('does not grant the resource when the receipt cannot be claimed', async () => {
    const ledger = {
      durable: true,
      async claim() {
        throw new Error('ledger down')
      },
      async settle() {},
      async get() {},
    }
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ ledger, facilitator })
    const { outcome } = await authorizeWith(adapter)

    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.LEDGER_UNAVAILABLE)
    assert.equal(facilitator.calls.length, 0, 'nothing is verified before a claim succeeds')
  })

  it('does not grant the resource when a verified receipt cannot be recorded', async () => {
    const inner = new InMemoryReceiptLedger()
    const ledger = {
      durable: true,
      claim: (c) => inner.claim(c),
      async settle() {
        throw new Error('write failed')
      },
      get: (k) => inner.get(k),
    }
    const adapter = build({ ledger })
    const { outcome } = await authorizeWith(adapter)

    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.LEDGER_UNAVAILABLE)
    assert.equal(outcome.operatorActionRequired, true)
    assert.equal(outcome.headers['PAYMENT-RESPONSE'], undefined)
  })
})

describe('site PaymentAdapter contract', () => {
  it('quotes with explicit decimal-string money and a configured destination', async () => {
    const adapter = build()
    const quote = await adapter.quote({ productId: 'privacy-check' })
    assert.equal(quote.productId, 'privacy-check')
    assert.equal(quote.amount, '100000')
    assert.equal(quote.fee, '0')
    assert.equal(quote.asset, 'ZEC')
    assert.equal(quote.network, 'zcash:mainnet')
    assert.equal(quote.payTo, FIXTURE_PAYTO_UA)
    assert.ok(Date.parse(quote.expiresAt) > 0)
    await assert.rejects(adapter.quote({ productId: '' }), AdapterConfigurationError)
  })

  it('settles a bare txid as succeeded and repeats the same result', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })
    const quote = await adapter.quote({ productId: 'privacy-check' })

    const first = await adapter.settle(quote, FIXTURE_TXID)
    assert.deepEqual(first, { status: 'succeeded', quoteId: quote.quoteId, reference: FIXTURE_TXID })
    assert.deepEqual(await adapter.settle(quote, FIXTURE_TXID), first)
    assert.equal(facilitator.calls.length, 1)
  })

  it('settles a full PAYMENT-SIGNATURE value as well as a bare txid', async () => {
    const adapter = build()
    const quote = await adapter.quote({ productId: 'privacy-check' })
    const challenge = adapter.createChallenge({ resource: RESOURCE, quoteId: quote.quoteId })
    const result = await adapter.settle(quote, paymentSignature(challenge))
    assert.equal(result.status, 'succeeded')
  })

  it('maps pending, failure and cancellation onto the contract', async () => {
    const pending = build({
      facilitator: stubFacilitator({ kind: OUTCOME.PENDING, reason: REASON.TRANSACTION_NOT_VISIBLE, detail: 'x', operatorActionRequired: false }),
    })
    const pendingQuote = await pending.quote({ productId: 'privacy-check' })
    assert.deepEqual(await pending.settle(pendingQuote, FIXTURE_TXID), {
      status: 'pending',
      quoteId: pendingQuote.quoteId,
      reference: FIXTURE_TXID,
    })

    const rejected = build({
      facilitator: stubFacilitator({ kind: OUTCOME.REJECTED, reason: REASON.INSUFFICIENT_FUNDS, detail: 'x', operatorActionRequired: false }),
    })
    const rejectedQuote = await rejected.quote({ productId: 'privacy-check' })
    const failure = await rejected.settle(rejectedQuote, FIXTURE_TXID)
    assert.equal(failure.status, 'failed')
    assert.equal(failure.retryable, false)

    const unavailable = build({
      facilitator: stubFacilitator({ kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.FACILITATOR_UNAVAILABLE, detail: 'x', operatorActionRequired: false }),
    })
    const unavailableQuote = await unavailable.quote({ productId: 'privacy-check' })
    const retryable = await unavailable.settle(unavailableQuote, FIXTURE_TXID)
    assert.equal(retryable.status, 'failed')
    assert.equal(retryable.retryable, true)

    const cancelled = build({
      facilitator: stubFacilitator({ kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.CANCELLED, detail: 'x', operatorActionRequired: false }),
    })
    const cancelledQuote = await cancelled.quote({ productId: 'privacy-check' })
    assert.deepEqual(await cancelled.settle(cancelledQuote, FIXTURE_TXID), {
      status: 'cancelled',
      quoteId: cancelledQuote.quoteId,
    })
  })

  it('passes the caller AbortSignal through to verification', async () => {
    const controller = new AbortController()
    const facilitator = stubFacilitator((args) => {
      assert.equal(args.signal, controller.signal)
      return { kind: OUTCOME.UPSTREAM_ERROR, reason: REASON.CANCELLED, detail: 'cancelled', operatorActionRequired: false }
    })
    const adapter = build({ facilitator })
    const quote = await adapter.quote({ productId: 'privacy-check' })
    const result = await adapter.settle(quote, FIXTURE_TXID, controller.signal)
    assert.equal(result.status, 'cancelled')
  })

  it('refuses a quote that does not match current configuration', async () => {
    const adapter = build()
    const quote = await adapter.quote({ productId: 'privacy-check' })

    for (const tampered of [
      { ...quote, amount: '1' },
      { ...quote, payTo: 'u1attacker' },
      { ...quote, network: 'zcash:testnet' },
    ]) {
      const result = await adapter.settle(tampered, FIXTURE_TXID)
      assert.equal(result.status, 'failed')
      assert.equal(result.retryable, false)
      assert.match(result.reason, /does not match current server configuration/)
    }
  })

  it('refuses a quote missing an id, an expiry or a usable amount', async () => {
    const adapter = build()
    const quote = await adapter.quote({ productId: 'privacy-check' })
    for (const broken of [
      { ...quote, quoteId: '' },
      { ...quote, expiresAt: 'not a date' },
      { ...quote, amount: '0.001' },
      undefined,
    ]) {
      assert.equal((await adapter.settle(broken, FIXTURE_TXID)).status, 'failed')
    }
  })
})

describe('settle only honours a quote this process issued', () => {
  it('refuses a quote with a rewritten expiry', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator, now: () => 1_000_000 })
    const quote = await adapter.quote({ productId: 'privacy-check' })

    // Same txid, same money, expiry moved 70-odd years into the future. Before
    // the mac this settled as `succeeded` and extended a dead quote.
    const extended = { ...quote, expiresAt: '2099-01-01T00:00:00.000Z' }
    const result = await adapter.settle(extended, FIXTURE_TXID)

    assert.equal(result.status, 'failed')
    assert.equal(result.retryable, false)
    assert.match(result.reason, /not issued by this server, or it has been altered/)
    assert.equal(facilitator.calls.length, 0)
  })

  it('refuses a second product on the same quote id', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })
    const quote = await adapter.quote({ productId: 'privacy-check' })
    assert.equal((await adapter.settle(quote, FIXTURE_TXID)).status, 'succeeded')

    const upsell = { ...quote, productId: 'founding-pass' }
    const result = await adapter.settle(upsell, FIXTURE_TXID)

    assert.equal(result.status, 'failed')
    assert.equal(result.retryable, false)
    assert.match(result.reason, /not issued by this server, or it has been altered/)
    // Only the first, legitimate settle reached the facilitator.
    assert.equal(facilitator.calls.length, 1)
  })

  it('refuses a quote object `quote()` never returned', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })
    const issued = await adapter.quote({ productId: 'privacy-check' })

    // Every field matches configuration; only the quote id was invented.
    const invented = { ...issued, quoteId: 'not-issued-by-quote' }
    const result = await adapter.settle(invented, FIXTURE_TXID)

    assert.equal(result.status, 'failed')
    assert.equal(result.retryable, false)
    assert.equal(facilitator.calls.length, 0)
  })

  it('refuses a quote whose asset was swapped', async () => {
    const adapter = build()
    const quote = await adapter.quote({ productId: 'privacy-check' })
    const result = await adapter.settle({ ...quote, asset: 'BTC' }, FIXTURE_TXID)
    assert.equal(result.status, 'failed')
    assert.equal(result.retryable, false)
    assert.match(result.reason, /does not match current server configuration/)
  })

  it('refuses a quote with no productId at all', async () => {
    const adapter = build()
    const quote = await adapter.quote({ productId: 'privacy-check' })
    const { productId: _dropped, ...withoutProduct } = quote
    assert.equal((await adapter.settle(withoutProduct, FIXTURE_TXID)).status, 'failed')
  })
})

describe('one txid grants one resource', () => {
  it('refuses an owned replay that points at a different resource', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })
    const other = { url: 'https://example.test/api/v1/founding-pass', description: 'Founding pass' }

    const first = await adapter.createChallenge({ resource: RESOURCE })
    const granted = await adapter.authorize({
      challenge: first,
      paymentSignatureHeader: paymentSignature(first),
      requestId: 'shared-request',
    })
    assert.equal(granted.kind, OUTCOME.VERIFIED)
    assert.equal(granted.replay, false)

    // Same request id and same price, a different resource. Before the receipt
    // stored the resource this came back `verified` with `replay: true`.
    const second = await adapter.createChallenge({ resource: other })
    const replayed = await adapter.authorize({
      challenge: second,
      paymentSignatureHeader: paymentSignature(second),
      requestId: 'shared-request',
    })

    assert.equal(replayed.kind, OUTCOME.REJECTED)
    assert.equal(replayed.reason, REASON.TXID_ALREADY_CLAIMED)
    assert.equal(facilitator.calls.length, 1)
  })

  it('still returns the stored grant when the same request retries the same resource', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator })
    const challenge = adapter.createChallenge({ resource: RESOURCE })
    const args = { challenge, paymentSignatureHeader: paymentSignature(challenge), requestId: 'one-request' }

    assert.equal((await adapter.authorize(args)).replay, false)
    const retry = await adapter.authorize(args)
    assert.equal(retry.kind, OUTCOME.VERIFIED)
    assert.equal(retry.replay, true)
    assert.equal(facilitator.calls.length, 1)
  })

  it('fails closed when the injected ledger drops the resource', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const forgetful = {
      durable: true,
      async claim({ resource: _dropped, ...claim }) {
        return { status: CLAIM.ACQUIRED, record: { ...claim, state: RECORD_STATE.CLAIMED } }
      },
      async settle(settlement) {
        return { ...settlement, updatedAt: 'now' }
      },
      async get() {
        return undefined
      },
    }
    const adapter = build({ ledger: forgetful, facilitator })
    const { outcome } = await authorizeWith(adapter)

    assert.equal(outcome.kind, OUTCOME.UPSTREAM_ERROR)
    assert.equal(outcome.reason, REASON.LEDGER_CONTRACT_VIOLATION)
    assert.equal(outcome.operatorFacing, true)
    assert.equal(facilitator.calls.length, 0)
  })
})

describe('an expired quote never reads as "pay again"', () => {
  it('tells a buyer who may already have paid to re-send the same txid', async () => {
    const facilitator = stubFacilitator({ kind: OUTCOME.VERIFIED })
    const adapter = build({ facilitator, now: () => 1_000_000 })
    const challenge = adapter.createChallenge({ resource: RESOURCE, ttlSeconds: 1 })
    const expired = build({ facilitator, now: () => 1_000_000 + 2_000 })

    const outcome = await expired.authorize({
      challenge,
      paymentSignatureHeader: paymentSignature(challenge),
    })

    assert.equal(outcome.reason, REASON.QUOTE_EXPIRED)
    assert.match(outcome.buyerMessage, /re-send the same transaction id/)
    assert.match(outcome.buyerMessage, /Do not send a second payment/)
    assert.doesNotMatch(outcome.buyerMessage, /for a new one\./)
    // Expiry is caught before the claim, so the same txid is still free to
    // settle the fresh quote the buyer is being sent to ask for.
    assert.equal(facilitator.calls.length, 0)
  })
})

describe('ledger claim shape', () => {
  it('claims by network, merchant, txid, request and price', async () => {
    const claims = []
    const ledger = {
      durable: true,
      async claim(claim) {
        claims.push(claim)
        return { status: CLAIM.ACQUIRED, record: { ...claim, state: RECORD_STATE.CLAIMED } }
      },
      async settle(settlement) {
        return { ...settlement, updatedAt: 'now' }
      },
      async get() {
        return undefined
      },
    }
    const adapter = build({ ledger })
    const { challenge } = await authorizeWith(adapter, { requestId: 'req-42' })

    assert.deepEqual(claims, [
      {
        network: 'zcash:mainnet',
        merchantId: adapter.merchantId,
        txid: FIXTURE_TXID,
        requestId: 'req-42',
        amountZatoshis: '100000',
        resource: RESOURCE.url,
      },
    ])
    assert.notEqual(challenge.quoteId, 'req-42')
  })
})
