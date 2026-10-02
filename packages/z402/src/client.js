import { assert, decodeHeader, encodeHeader, hash, identity, nonce, paymentRequired, resourceHash, signDocument, validateOffer, verifyDocument, zatoshis } from './protocol.js'
import { ciphertextDigest, decryptResource, verifyReceipt } from './receipts.js'

export class AgentClient {
  constructor({ store, native, transport, merchants, maxAmountZat, feeCapZat }) {
    assert(store && native && typeof transport === 'function' && typeof merchants === 'object', 'invalid_client_configuration')
    zatoshis(maxAmountZat); zatoshis(feeCapZat, true)
    Object.assign(this, { store, native, transport, merchants, maxAmountZat, feeCapZat })
  }
  async purchase(url, { purchaseId }) {
    assert(typeof purchaseId === 'string' && /^[a-f0-9]{48}$/.test(purchaseId), 'purchase_id_required')
    const merchantKey = this.merchants[new URL(url).origin]
    assert(typeof merchantKey === 'string', 'merchant_not_allowed')
    return this.store.locked('agent-wallet', async () => {
      let saved = this.store.get(`agent:${purchaseId}`)
      if (!saved) {
        saved = { url, buyer: identity(), response: identity('x25519'), state: 'created' }
        this.store.put(`agent:${purchaseId}`, saved)
      }
      assert(saved.url === url, 'purchase_resource_changed')
      if (saved.state === 'fulfilled') return Buffer.from(saved.body, 'base64')
      const intent = { id: purchaseId, buyerKey: saved.buyer.publicKey, responseKey: saved.response.publicKey, requestHash: resourceHash('GET', url) }
      const bootstrap = { id: intent.id, buyerKey: intent.buyerKey, responseKey: intent.responseKey, signature: signDocument('request', intent, saved.buyer.privateKey) }
      const headers = { 'z402-request': encodeHeader(bootstrap) }
      if (!saved.offer) {
        const response = await this.transport(url, { headers, purchaseId })
        assert(response.status === 402, 'payment_challenge_required')
        const challenge = decodeHeader(response.headers.get('payment-required'))
        assert(challenge.x402Version === 2 && challenge.accepts?.length === 1, 'unsupported_payment')
        const signed = challenge.accepts[0].extra?.z402
        assert(signed?.merchantKey === merchantKey, 'untrusted_merchant')
        const offer = validateOffer(signed.offer)
        verifyDocument('offer', offer, signed.signature, merchantKey)
        assert(offer.id === purchaseId && offer.url === url && offer.buyerKey === saved.buyer.publicKey && offer.responseKey === saved.response.publicKey, 'quote_mismatch')
        assert(zatoshis(offer.amountZat) <= zatoshis(this.maxAmountZat) && zatoshis(offer.feeCapZat, true) <= zatoshis(this.feeCapZat, true), 'spend_policy_refused')
        saved.offer = offer; saved.offerSignature = signed.signature
        this.store.put(`agent:${purchaseId}`, saved)
      }
      const offer = saved.offer
      this.store.reserve(purchaseId, String(zatoshis(offer.amountZat) + zatoshis(offer.feeCapZat, true)))
      if (!saved.pcztHex) {
        validateOffer(offer)
        const proposal = await this.native.propose({ offer, offerSignature: saved.offerSignature })
        assert(typeof proposal.pcztHex === 'string' && zatoshis(proposal.feeZat, true) <= zatoshis(offer.feeCapZat, true), 'fee_cap_exceeded')
        saved.pcztHex = proposal.pcztHex; saved.feeZat = proposal.feeZat; saved.state = 'proposed'
        this.store.put(`agent:${purchaseId}`, saved)
      }
      if (!saved.signedPcztHex) {
        validateOffer(offer)
        const signed = await this.native.sign({ offer, offerSignature: saved.offerSignature, pcztHex: saved.pcztHex })
        assert(typeof signed.pcztHex === 'string' && signed.feeZat === saved.feeZat, 'signed_payment_mismatch')
        saved.signedPcztHex = signed.pcztHex; saved.state = 'signed'
        this.store.put(`agent:${purchaseId}`, saved)
      }
      if (!saved.txid) {
        const submitted = await this.native.submit({ offer, offerSignature: saved.offerSignature, pcztHex: saved.signedPcztHex })
        assert(typeof submitted.txid === 'string' && /^[a-f0-9]{64}$/.test(submitted.txid), 'invalid_native_transaction')
        saved.txid = submitted.txid; saved.state = 'broadcast'
        this.store.put(`agent:${purchaseId}`, saved)
      }
      if (!saved.proof) {
        const disclosed = await this.native.disclose({ offer, offerSignature: saved.offerSignature, txid: saved.txid })
        saved.proof = { txid: saved.txid, disclosureHex: disclosed.disclosureHex }
        this.store.put(`agent:${purchaseId}`, saved)
      }
      const accepted = paymentRequired({ offer, signature: saved.offerSignature, merchantKey }).accepts[0]
      const proofHash = hash(saved.proof), offerHash = hash(offer)
      const envelope = { x402Version: 2, accepted, payload: { offerHash, proof: saved.proof, signature: signDocument('payment', { offerHash, proofHash }, saved.buyer.privateKey) } }
      const response = await this.transport(url, { headers: { ...headers, 'payment-signature': encodeHeader(envelope) }, purchaseId })
      if ([202, 409, 503].includes(response.status)) return { status: 'pending', retrySamePurchase: true }
      assert(response.status === 200, 'merchant_response_refused')
      const completed = await response.json()
      assert(completed.receipt.offer.id === purchaseId && hash(completed.receipt.offer) === offerHash, 'receipt_quote_mismatch')
      const verification = await verifyReceipt(completed.receipt, { merchantKey, native: this.native })
      assert(verification.meetsConfirmationPolicy, 'payment_pending')
      assert(ciphertextDigest(completed.encrypted) === completed.receipt.encryptedDigest, 'encrypted_resource_mismatch')
      const body = decryptResource(completed.encrypted, saved.response.privateKey, offerHash)
      assert(hash(body.toString('base64')) === completed.receipt.resourceDigest, 'resource_digest_mismatch')
      this.store.charge(purchaseId, String(zatoshis(offer.amountZat) + zatoshis(saved.feeZat, true)))
      this.store.put(`agent:${purchaseId}`, { ...saved, state: 'fulfilled', receipt: completed.receipt, body: body.toString('base64') })
      return body
    })
  }
  newPurchaseId() { return nonce() }
}
