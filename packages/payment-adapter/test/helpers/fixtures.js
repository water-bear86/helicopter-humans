/**
 * Local test fixtures. Every value here is invented for offline tests.
 *
 * These are NOT provider testnet values -- CipherPay does not operate a
 * testnet. The fixture address is not a real Zcash address, the API key is
 * not a credential, and no test in this package touches the network.
 */

/** Shaped like a unified address so config validation accepts it. Not real. */
export const FIXTURE_PAYTO_UA =
  'u1fixturefixturefixturefixturefixturefixturefixturefixturefixture00'

/** Not a credential. Never a real key, never a real key's shape. */
export const FIXTURE_API_KEY = 'fixture-not-a-real-key'

/** Test price only. 100000 zatoshis = 0.001 ZEC. Not an approved price. */
export const FIXTURE_PRICE_ZATOSHIS = '100000'

export const FIXTURE_TXID = 'a'.repeat(64)
export const OTHER_FIXTURE_TXID = 'b'.repeat(64)

/** A loopback facilitator URL, which puts the adapter in `test` mode. */
export const FIXTURE_FACILITATOR_URL = 'http://127.0.0.1:59999'

export function fixtureEnv(overrides = {}) {
  return {
    CIPHERPAY_API_KEY: FIXTURE_API_KEY,
    ZCASH_PAYTO_UA: FIXTURE_PAYTO_UA,
    ZCASH_PRICE_ZATOSHIS: FIXTURE_PRICE_ZATOSHIS,
    CIPHERPAY_FACILITATOR_URL: FIXTURE_FACILITATOR_URL,
    CIPHERPAY_NETWORK: 'zcash:mainnet',
    ...overrides,
  }
}

/** Build a `PAYMENT-SIGNATURE` header value for a challenge. */
export function paymentSignature(challenge, { txid = FIXTURE_TXID, accepted, x402Version = 2 } = {}) {
  const envelope = {
    x402Version,
    accepted: accepted ?? { ...challenge.requirements, extra: {} },
    payload: { txid },
  }
  return Buffer.from(JSON.stringify(envelope), 'utf8').toString('base64')
}

/** A `fetch` stand-in that replays scripted responses and records requests. */
export function scriptedFetch(script) {
  const calls = []
  const queue = [...script]
  const impl = async (url, init) => {
    calls.push({ url, init })
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (next === undefined) throw new Error('scriptedFetch ran out of responses')
    if (typeof next === 'function') return next(url, init)
    const { status = 200, body = {}, headers = {} } = next
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })
  }
  impl.calls = calls
  return impl
}

/** A facilitator stand-in, so adapter tests do not go through HTTP at all. */
export function stubFacilitator(outcomes) {
  const queue = Array.isArray(outcomes) ? [...outcomes] : [outcomes]
  const calls = []
  return {
    verifyUrl: `${FIXTURE_FACILITATOR_URL}/api/x402/v2/verify`,
    calls,
    async verify(args) {
      calls.push(args)
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (typeof next === 'function') return next(args)
      return next
    },
  }
}

export const noSleep = async () => {}
