import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'

export const NETWORKS = Object.freeze(['zcash:regtest', 'zcash:testnet'])
export const PROFILES = Object.freeze(['zally-ironwood-v1'])
export const MAX_ZAT = 2_100_000_000_000_000n
const DOMAIN = 'z402/private-purchase/v1/'
const OFFER_KEYS = ['version', 'id', 'network', 'asset', 'amountZat', 'feeCapZat', 'payTo', 'method', 'url', 'requestHash', 'buyerKey', 'responseKey', 'createdAt', 'expiresAt', 'profile', 'minimumConfirmations']

export class Z402Error extends Error {
  constructor(code) { super(code); this.name = 'Z402Error'; this.code = code }
}
export function assert(condition, code) { if (!condition) throw new Z402Error(code) }
export function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
export function exactKeys(value, keys) {
  assert(object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'invalid_fields')
}
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') { assert(Number.isSafeInteger(value), 'invalid_number'); return String(value) }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  assert(object(value) && Object.getPrototypeOf(value) === Object.prototype, 'invalid_object')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
export function hash(value) { return createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex') }
export function nonce() { return randomBytes(24).toString('hex') }
export function zatoshis(value, allowZero = false) {
  assert(typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value), 'invalid_zatoshis')
  const amount = BigInt(value)
  assert(amount <= MAX_ZAT && (allowZero || amount > 0n), 'invalid_zatoshis')
  return amount
}
export function identity(type = 'ed25519') {
  assert(type === 'ed25519' || type === 'x25519', 'invalid_key_type')
  const pair = generateKeyPairSync(type)
  return {
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  }
}
export function publicKey(encoded, type = 'ed25519') {
  assert(typeof encoded === 'string' && encoded.length <= 100, 'invalid_key')
  const bytes = Buffer.from(encoded, 'base64')
  assert(bytes.toString('base64') === encoded, 'invalid_key')
  try {
    const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' })
    assert(key.asymmetricKeyType === type, 'invalid_key')
    return key
  } catch { throw new Z402Error('invalid_key') }
}
export function privateKey(encoded) {
  try { return createPrivateKey({ key: Buffer.from(encoded, 'base64'), type: 'pkcs8', format: 'der' }) }
  catch { throw new Z402Error('invalid_private_key') }
}
export function signDocument(kind, value, secret) {
  return sign(null, Buffer.from(DOMAIN + kind + '\n' + canonical(value)), privateKey(secret)).toString('base64')
}
export function verifyDocument(kind, value, signature, key) {
  assert(typeof signature === 'string' && signature.length === 88, 'invalid_signature')
  assert(verify(null, Buffer.from(DOMAIN + kind + '\n' + canonical(value)), publicKey(key), Buffer.from(signature, 'base64')), 'invalid_signature')
}
export function resourceHash(method, url) { return hash({ method, url }) }
export function validateOffer(offer, { now = Date.now(), permitExpired = false } = {}) {
  exactKeys(offer, OFFER_KEYS)
  assert(offer.version === 1 && offer.asset === 'ZEC' && NETWORKS.includes(offer.network) && PROFILES.includes(offer.profile), 'unsupported_profile')
  assert(typeof offer.id === 'string' && /^[a-f0-9]{48}$/.test(offer.id), 'invalid_purchase_id')
  zatoshis(offer.amountZat); zatoshis(offer.feeCapZat, true)
  assert(zatoshis(offer.amountZat) + zatoshis(offer.feeCapZat, true) <= MAX_ZAT, 'invalid_total')
  assert(typeof offer.payTo === 'string' && offer.payTo.length >= 30 && offer.payTo.length <= 512, 'invalid_recipient')
  assert(offer.method === 'GET', 'unsupported_method')
  let url
  try { url = new URL(offer.url) } catch { throw new Z402Error('invalid_resource') }
  assert(!url.username && !url.password && !url.hash && (url.protocol === 'https:' || (offer.network === 'zcash:regtest' && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))), 'invalid_resource')
  assert(offer.requestHash === resourceHash(offer.method, offer.url), 'resource_mismatch')
  publicKey(offer.buyerKey); publicKey(offer.responseKey, 'x25519')
  assert(Number.isSafeInteger(offer.createdAt) && Number.isSafeInteger(offer.expiresAt) && offer.createdAt <= now + 30_000 && offer.expiresAt > offer.createdAt && offer.expiresAt - offer.createdAt <= 3_600_000, 'invalid_expiry')
  assert(permitExpired || offer.expiresAt > now, 'quote_expired')
  assert(Number.isSafeInteger(offer.minimumConfirmations) && offer.minimumConfirmations >= 1 && offer.minimumConfirmations <= 100, 'invalid_confirmations')
  return offer
}
export function encodeHeader(value) { return Buffer.from(canonical(value)).toString('base64') }
export function decodeHeader(encoded, maxBytes = 16_384) {
  assert(typeof encoded === 'string' && encoded.length > 0 && encoded.length <= Math.ceil(maxBytes * 4 / 3) + 4 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'invalid_header')
  const bytes = Buffer.from(encoded, 'base64')
  assert(bytes.length <= maxBytes && bytes.toString('base64') === encoded, 'invalid_header')
  try { return JSON.parse(bytes.toString('utf8')) } catch { throw new Z402Error('invalid_header') }
}
export function paymentRequired(signedOffer) {
  const offer = signedOffer.offer
  return { x402Version: 2, resource: { url: offer.url }, accepts: [{ scheme: 'z402-shielded-v1', network: offer.network, asset: 'ZEC', amount: offer.amountZat, payTo: offer.payTo, maxTimeoutSeconds: Math.ceil((offer.expiresAt - offer.createdAt) / 1000), extra: { z402: signedOffer } }] }
}
export function validateProof(proof) {
  exactKeys(proof, ['txid', 'disclosureHex'])
  assert(typeof proof.txid === 'string' && /^[a-f0-9]{64}$/.test(proof.txid), 'invalid_transaction')
  assert(typeof proof.disclosureHex === 'string' && proof.disclosureHex.length >= 2 && proof.disclosureHex.length <= 16_000 && /^(?:[a-f0-9]{2})+$/.test(proof.disclosureHex), 'invalid_disclosure')
  return proof
}
