import { assert, canonical, decodeHeader, encodeHeader, exactKeys, hash, paymentRequired, publicKey, resourceHash, signDocument, validateOffer, validateProof, verifyDocument, Z402Error } from './protocol.js'
import { ciphertextDigest, encryptResource } from './receipts.js'

const HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
export function createMerchant({ identity, store, native, network, payTo, profile = 'zally-ironwood-v1', feeCapZat = '100000', minimumConfirmations = 1, quoteTtlMs = 600_000, resources }) {
  publicKey(identity.publicKey)
  assert(store && native && typeof resources === 'object' && Number.isSafeInteger(quoteTtlMs) && quoteTtlMs > 0 && quoteTtlMs <= 3_600_000, 'invalid_merchant_configuration')
  const respond = (body, status, headers = {}) => Response.json(body, { status, headers: { ...HEADERS, ...headers } })
  return async function handle(request) {
    try {
      assert(request.method === 'GET', 'unsupported_method')
      assert(!request.headers.has('origin'), 'browser_request_refused')
      const resource = resources[request.url]
      if (!resource) return respond({ error: 'resource_not_found' }, 404)
      const bootstrap = decodeHeader(request.headers.get('z402-request'))
      exactKeys(bootstrap, ['id', 'buyerKey', 'responseKey', 'signature'])
      const intent = { id: bootstrap.id, buyerKey: bootstrap.buyerKey, responseKey: bootstrap.responseKey, requestHash: resourceHash('GET', request.url) }
      assert(typeof intent.id === 'string' && /^[a-f0-9]{48}$/.test(intent.id), 'invalid_purchase_id')
      publicKey(intent.responseKey, 'x25519')
      verifyDocument('request', intent, bootstrap.signature, intent.buyerKey)
      return await store.locked(`merchant:${intent.id}`, async () => {
        let saved = store.get(`merchant:${intent.id}`)
        if (saved) assert(saved.intentHash === hash(intent), 'purchase_identity_changed')
        if (!saved) {
          const offer = validateOffer({ version: 1, id: intent.id, network, asset: 'ZEC', amountZat: resource.amountZat, feeCapZat, payTo, method: 'GET', url: request.url, requestHash: intent.requestHash, buyerKey: intent.buyerKey, responseKey: intent.responseKey, createdAt: Date.now(), expiresAt: Date.now() + quoteTtlMs, profile, minimumConfirmations })
          saved = { intentHash: hash(intent), offer, offerSignature: signDocument('offer', offer, identity.privateKey), state: 'quoted' }
          store.put(`merchant:${intent.id}`, saved)
        }
        const header = request.headers.get('payment-signature')
        if (!header) {
          validateOffer(saved.offer)
          const challenge = paymentRequired({ offer: saved.offer, signature: saved.offerSignature, merchantKey: identity.publicKey })
          return respond(challenge, 402, { 'payment-required': encodeHeader(challenge) })
        }
        const envelope = decodeHeader(header)
        exactKeys(envelope, ['x402Version', 'accepted', 'payload'])
        exactKeys(envelope.payload, ['offerHash', 'proof', 'signature'])
        assert(envelope.x402Version === 2, 'unsupported_protocol')
        const requirements = paymentRequired({ offer: saved.offer, signature: saved.offerSignature, merchantKey: identity.publicKey }).accepts[0]
        assert(canonical(envelope.accepted) === canonical(requirements) && envelope.payload.offerHash === hash(saved.offer), 'quote_mismatch')
        const proof = validateProof(envelope.payload.proof)
        verifyDocument('payment', { offerHash: hash(saved.offer), proofHash: hash(proof) }, envelope.payload.signature, saved.offer.buyerKey)
        if (saved.receipt) {
          assert(saved.receipt.proof.txid === proof.txid, 'purchase_already_paid')
          return respond({ encrypted: saved.encrypted, receipt: saved.receipt }, 200, { 'payment-response': encodeHeader({ success: true, network, transaction: proof.txid }) })
        }
        const chain = await native.verify({ offer: saved.offer, proof })
        if (chain.chainPresent === false) return respond({ status: 'pending', retrySamePurchase: true }, 202, { 'retry-after': '5' })
        assert(chain.cryptographic === true && chain.memoMatch === true && chain.amountMatch === true && chain.recipientMatch === true && chain.txid === proof.txid, 'payment_invalid')
        if (chain.chainPresent !== true || chain.confirmations < saved.offer.minimumConfirmations) return respond({ status: 'pending', retrySamePurchase: true }, 202, { 'retry-after': '5' })
        assert(Number.isSafeInteger(chain.outputIndex) && chain.outputIndex >= 0 && store.claim(network, proof.txid, chain.outputIndex, saved.offer.id), 'payment_already_claimed')
        // GET resources must honor purchaseId as an idempotency key across a crash in delivery.
        const output = await resource.read({ purchaseId: saved.offer.id })
        assert(output instanceof Uint8Array && output.byteLength <= 262_144, 'invalid_resource_response')
        const encrypted = encryptResource(output, saved.offer.responseKey, hash(saved.offer))
        const acknowledgment = { offerHash: hash(saved.offer), txid: proof.txid, outputIndex: chain.outputIndex, resourceDigest: hash(Buffer.from(output).toString('base64')), encryptedDigest: ciphertextDigest(encrypted), observedAt: Date.now() }
        const receipt = { version: 1, merchantKey: identity.publicKey, offer: saved.offer, offerSignature: saved.offerSignature, proof, chain, resourceDigest: acknowledgment.resourceDigest, encryptedDigest: acknowledgment.encryptedDigest, observedAt: acknowledgment.observedAt, signature: signDocument('receipt', acknowledgment, identity.privateKey) }
        store.put(`merchant:${intent.id}`, { ...saved, state: 'fulfilled', encrypted, receipt })
        return respond({ encrypted, receipt }, 200, { 'payment-response': encodeHeader({ success: true, network, transaction: proof.txid }) })
      })
    } catch (error) {
      const code = error instanceof Z402Error ? error.code : 'merchant_unavailable'
      return respond({ error: code, retrySamePurchase: true }, code === 'purchase_busy' ? 409 : code === 'merchant_unavailable' || code.startsWith('native_') ? 503 : 400)
    }
  }
}
