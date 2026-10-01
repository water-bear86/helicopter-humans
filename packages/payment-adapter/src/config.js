/**
 * Configuration resolution. The adapter is disabled unless every required
 * variable is present and valid: an unconfigured deployment must not look
 * like a working paid service.
 *
 * Variable names (values never appear in this repository):
 *   CIPHERPAY_API_KEY        merchant API key issued by CipherPay
 *   ZCASH_PAYTO_UA           unified address with a shielded receiver
 *   CIPHERPAY_FACILITATOR_URL  defaults to https://api.cipherpay.app
 *   CIPHERPAY_NETWORK        defaults to zcash:mainnet
 *   ZCASH_PRICE_ZATOSHIS     integer zatoshis, no default
 */

import { parseZatoshis } from './amounts.js'

export const HOSTED_FACILITATOR_URL = 'https://api.cipherpay.app'

/**
 * The only network the hosted facilitator advertises.
 * `GET https://api.cipherpay.app/api/x402/supported` returned exactly one
 * kind: `{x402Version: 2, scheme: "exact", network: "zcash:mainnet"}`.
 * There is no provider testnet.
 */
export const SUPPORTED_NETWORK = 'zcash:mainnet'

export const SCHEME = 'exact'
export const ASSET = 'ZEC'
export const X402_VERSION = 2

/** Path of the verify endpoint, relative to the facilitator base URL. */
export const VERIFY_PATH = '/api/x402/v2/verify'

export const ENV_KEYS = Object.freeze({
  apiKey: 'CIPHERPAY_API_KEY',
  payTo: 'ZCASH_PAYTO_UA',
  facilitatorUrl: 'CIPHERPAY_FACILITATOR_URL',
  network: 'CIPHERPAY_NETWORK',
  priceZatoshis: 'ZCASH_PRICE_ZATOSHIS',
})

/**
 * A Zcash unified address. Only a UA can carry a shielded (Orchard/Ironwood)
 * receiver, and only a shielded receiver gives the privacy this product
 * claims. `t1`/`t3` are transparent and `zs1` is a bare Sapling address --
 * both are rejected outright rather than quietly accepted.
 */
const UNIFIED_ADDRESS = /^u1[0-9a-z]{40,}$/

function classifyAddress(value) {
  if (UNIFIED_ADDRESS.test(value)) return 'unified'
  if (/^t[13][1-9A-HJ-NP-Za-km-z]{20,}$/.test(value)) return 'transparent'
  if (/^zs1[0-9a-z]{20,}$/.test(value)) return 'sapling'
  return 'unknown'
}

function normaliseBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: `${ENV_KEYS.facilitatorUrl} is not a valid URL` }
  }
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    return {
      ok: false,
      reason: `${ENV_KEYS.facilitatorUrl} must use https, except for a loopback fixture host`,
    }
  }
  if (url.search !== '' || url.hash !== '') {
    return { ok: false, reason: `${ENV_KEYS.facilitatorUrl} must not carry a query or fragment` }
  }
  return { ok: true, value: url.origin + url.pathname.replace(/\/+$/, '') }
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

function read(env, key) {
  const raw = env[key]
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Resolve configuration from an environment-like object.
 *
 * Returns `mode: 'disabled'` with human-readable `problems` whenever anything
 * required is missing or wrong -- callers must treat that as "there is no paid
 * route here", never as a soft warning.
 *
 * `mode: 'test'` means the facilitator base URL is a loopback fixture server
 * under our own control. It does NOT mean a provider testnet: CipherPay does
 * not operate one.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {import('../types/index.js').ResolvedConfig}
 */
export function resolveConfig(env = process.env) {
  const problems = []

  const apiKey = read(env, ENV_KEYS.apiKey)
  if (apiKey === undefined) problems.push(`${ENV_KEYS.apiKey} is not set`)

  const payTo = read(env, ENV_KEYS.payTo)
  if (payTo === undefined) {
    problems.push(`${ENV_KEYS.payTo} is not set`)
  } else {
    const kind = classifyAddress(payTo)
    if (kind === 'transparent') {
      problems.push(
        `${ENV_KEYS.payTo} is a transparent address; a transparent transfer is public and cannot be the shielded product`,
      )
    } else if (kind !== 'unified') {
      problems.push(
        `${ENV_KEYS.payTo} must be a Zcash unified address beginning with "u1" and containing a shielded receiver`,
      )
    }
  }

  const network = read(env, ENV_KEYS.network) ?? SUPPORTED_NETWORK
  if (network !== SUPPORTED_NETWORK) {
    problems.push(
      `${ENV_KEYS.network} is "${network}"; the hosted facilitator advertises only "${SUPPORTED_NETWORK}"`,
    )
  }

  let priceZatoshis
  const rawPrice = read(env, ENV_KEYS.priceZatoshis)
  if (rawPrice === undefined) {
    problems.push(`${ENV_KEYS.priceZatoshis} is not set`)
  } else {
    const parsed = parseZatoshis(rawPrice)
    if (parsed.ok) {
      priceZatoshis = parsed.value
    } else {
      problems.push(`${ENV_KEYS.priceZatoshis}: ${parsed.reason}`)
    }
  }

  let facilitatorUrl
  const rawUrl = read(env, ENV_KEYS.facilitatorUrl) ?? HOSTED_FACILITATOR_URL
  const normalised = normaliseBaseUrl(rawUrl)
  if (normalised.ok) {
    facilitatorUrl = normalised.value
  } else {
    problems.push(normalised.reason)
  }

  if (problems.length > 0) {
    return { mode: 'disabled', problems: Object.freeze(problems), config: undefined }
  }

  const hosted = facilitatorUrl === HOSTED_FACILITATOR_URL

  return {
    mode: hosted ? 'live' : 'test',
    problems: Object.freeze([]),
    config: Object.freeze({
      apiKey,
      payTo,
      network,
      facilitatorUrl,
      priceZatoshis,
      hostedFacilitator: hosted,
    }),
  }
}
