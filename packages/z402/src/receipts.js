import { createCipheriv, createDecipheriv, diffieHellman, hkdfSync, randomBytes } from 'node:crypto'
import { assert, canonical, hash, identity, privateKey, publicKey, validateOffer, validateProof, verifyDocument } from './protocol.js'

export function encryptResource(bytes, responseKey, offerHash) {
  const ephemeral = identity('x25519')
  const secret = diffieHellman({ privateKey: privateKey(ephemeral.privateKey), publicKey: publicKey(responseKey, 'x25519') })
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.from(offerHash, 'hex'), 'z402/resource/v1', 32))
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(offerHash, 'hex'))
  const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()])
  return { ephemeralKey: ephemeral.publicKey, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: encrypted.toString('base64') }
}
export function decryptResource(encrypted, responseSecret, offerHash) {
  const secret = diffieHellman({ privateKey: privateKey(responseSecret), publicKey: publicKey(encrypted.ephemeralKey, 'x25519') })
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.from(offerHash, 'hex'), 'z402/resource/v1', 32))
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'))
  decipher.setAAD(Buffer.from(offerHash, 'hex')); decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()])
}
export async function verifyReceipt(receipt, { merchantKey, native }) {
  assert(receipt?.version === 1 && receipt.merchantKey === merchantKey, 'untrusted_merchant')
  validateOffer(receipt.offer, { permitExpired: true })
  validateProof(receipt.proof)
  verifyDocument('offer', receipt.offer, receipt.offerSignature, merchantKey)
  const acknowledgment = { offerHash: hash(receipt.offer), txid: receipt.proof.txid, outputIndex: receipt.chain.outputIndex, resourceDigest: receipt.resourceDigest, encryptedDigest: receipt.encryptedDigest, observedAt: receipt.observedAt }
  verifyDocument('receipt', acknowledgment, receipt.signature, merchantKey)
  const evidence = await native.verify({ offer: receipt.offer, proof: receipt.proof })
  assert(evidence.cryptographic === true && evidence.memoMatch === true && evidence.amountMatch === true && evidence.recipientMatch === true, 'receipt_invalid')
  assert(evidence.txid === receipt.proof.txid && evidence.outputIndex === receipt.chain.outputIndex, 'transaction_mismatch')
  return { cryptographic: true, chainPresent: evidence.chainPresent === true, confirmations: evidence.confirmations, meetsConfirmationPolicy: evidence.chainPresent === true && evidence.confirmations >= receipt.offer.minimumConfirmations, experimental: true }
}
export function ciphertextDigest(encrypted) { return hash(canonical(encrypted)) }
