import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AgentClient, PrivateStore, createMerchant, identity, nonce, verifyReceipt, torTransport, regtestTransport } from '../index.js'
import { canonical, decodeHeader, encodeHeader, hash, signDocument, validateOffer, verifyDocument } from '../src/protocol.js'
import { encryptResource, decryptResource } from '../src/receipts.js'

// This fake tests protocol control flow only. Native settlement has a separate live gate.
function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'z402-test-')), key = randomBytes(32), merchant = identity()
  const path = join(dir, 'agent.sqlite'), merchantPath = join(dir, 'merchant.sqlite')
  let store = new PrivateStore(path, key, { budgetZat: options.budget || '1000000' })
  let merchantStore = new PrivateStore(merchantPath, key)
  const counts = { propose: 0, sign: 0, submit: 0, read: 0 }
  let confirmations = options.confirmations ?? 1
  const native = {
    async propose({ offer }) { counts.propose++; return { pcztHex: hash(offer), feeZat: '10000' } },
    async sign({ pcztHex }) { counts.sign++; return { pcztHex, feeZat: '10000' } },
    async submit({ pcztHex }) { counts.submit++; return { txid: pcztHex } },
    async disclose({ offer }) { return { disclosureHex: Buffer.from(hash(offer)).toString('hex') } },
    async verify({ offer, proof }) { return { cryptographic: true, memoMatch: proof.disclosureHex === Buffer.from(hash(offer)).toString('hex'), amountMatch: true, recipientMatch: true, chainPresent: true, txid: proof.txid, outputIndex: 1, confirmations } },
  }
  const url = 'http://127.0.0.1:4242/report'
  function handler() { return createMerchant({ identity: merchant, store: merchantStore, native, network: 'zcash:regtest', payTo: 'uregtest1' + 'a'.repeat(50), feeCapZat: '20000', resources: { [url]: { amountZat: '50000', read: async () => { counts.read++; return Buffer.from('a real resource body') } } } }) }
  let handle = handler(), intercept
  function client() { return new AgentClient({ store, native, transport: async (resource, { headers }) => { const result = await handle(new Request(resource, { headers })); return intercept ? intercept(result) : result }, merchants: { [new URL(url).origin]: merchant.publicKey }, maxAmountZat: '100000', feeCapZat: '20000' }) }
  return { dir, key, path, native, merchant, url, counts, client, get store() { return store }, set confirmations(value) { confirmations = value }, set intercept(value) { intercept = value }, restart() { store.close(); merchantStore.close(); store = new PrivateStore(path,key,{budgetZat:options.budget || '1000000'}); merchantStore = new PrivateStore(merchantPath,key); handle = handler() }, close() { store.close(); merchantStore.close(); rmSync(dir,{recursive:true,force:true}) } }
}
test('purchase, portable receipt, restart and retry spend once', async () => {
  const h = harness()
  try {
    const id = nonce(), client = h.client()
    assert.equal((await client.purchase(h.url,{purchaseId:id})).toString(),'a real resource body')
    const saved = h.store.get(`agent:${id}`)
    assert.equal((await verifyReceipt(saved.receipt,{merchantKey:h.merchant.publicKey,native:h.native})).meetsConfirmationPolicy,true)
    assert.equal(readFileSync(h.path).includes(Buffer.from(saved.buyer.privateKey)),false)
    h.restart()
    assert.equal((await h.client().purchase(h.url,{purchaseId:id})).toString(),'a real resource body')
    assert.deepEqual(h.counts,{propose:1,sign:1,submit:1,read:1})
  } finally { h.close() }
})
test('lost delivery response retries persisted payment and encrypted resource', async () => {
  const h = harness()
  try {
    const id = nonce()
    h.intercept = response => { if(response.status === 200) throw new Error('simulated disconnect'); return response }
    await assert.rejects(h.client().purchase(h.url,{purchaseId:id}), /disconnect/)
    h.restart(); h.intercept = undefined
    assert.equal((await h.client().purchase(h.url,{purchaseId:id})).toString(),'a real resource body')
    assert.deepEqual(h.counts,{propose:1,sign:1,submit:1,read:1})
  } finally { h.close() }
})
test('unconfirmed payment stays pending and retries without another broadcast', async () => {
  const h = harness({confirmations:0})
  try {
    const id = nonce()
    assert.deepEqual(await h.client().purchase(h.url,{purchaseId:id}),{status:'pending',retrySamePurchase:true})
    assert.equal(h.counts.read,0)
    h.restart(); h.confirmations = 2
    await h.client().purchase(h.url,{purchaseId:id})
    assert.equal(h.counts.submit,1)
  } finally { h.close() }
})
test('budget refuses before proposal and survives restart', async () => {
  const h = harness({budget:'70000'})
  try {
    await h.client().purchase(h.url,{purchaseId:nonce()}); h.restart()
    await assert.rejects(h.client().purchase(h.url,{purchaseId:nonce()}),/budget_exhausted/)
    assert.equal(h.counts.propose,1)
  } finally { h.close() }
})
test('merchant pin and modified receipt fail closed', async () => {
  const h = harness()
  try {
    const id = nonce(); await h.client().purchase(h.url,{purchaseId:id})
    const receipt = h.store.get(`agent:${id}`).receipt
    await assert.rejects(verifyReceipt(receipt,{merchantKey:identity().publicKey,native:h.native}),/untrusted_merchant/)
    await assert.rejects(verifyReceipt({...receipt,resourceDigest:'0'.repeat(64)},{merchantKey:h.merchant.publicKey,native:h.native}),/invalid_signature/)
    const changed = {...receipt,proof:{...receipt.proof,disclosureHex:'ab'}}
    await assert.rejects(verifyReceipt(changed,{merchantKey:h.merchant.publicKey,native:h.native}),/receipt_invalid/)
  } finally { h.close() }
})
test('different purchases use unrelated buyer and response keys', async () => {
  const h = harness()
  try {
    const a = nonce(), b = nonce()
    await h.client().purchase(h.url,{purchaseId:a}); await h.client().purchase(h.url,{purchaseId:b})
    assert.notEqual(h.store.get(`agent:${a}`).offer.buyerKey,h.store.get(`agent:${b}`).offer.buyerKey)
    assert.notEqual(h.store.get(`agent:${a}`).offer.responseKey,h.store.get(`agent:${b}`).offer.responseKey)
  } finally { h.close() }
})
test('durable output claim allows one purchase and idempotent retry', () => {
  const h = harness()
  try { assert.equal(h.store.claim('zcash:regtest','a'.repeat(64),1,'first'),true); h.restart(); assert.equal(h.store.claim('zcash:regtest','a'.repeat(64),1,'first'),true); assert.equal(h.store.claim('zcash:regtest','a'.repeat(64),1,'second'),false) } finally { h.close() }
})
test('concurrent wallet operations cannot share a reservation window', async () => {
  const h = harness()
  try {
    await h.store.locked('agent-wallet', async () => assert.rejects(h.store.locked('agent-wallet',async () => {}),/purchase_busy/))
  } finally { h.close() }
})
test('signed documents, bounded headers and resource encryption reject mutations', () => {
  const key = identity(), response = identity('x25519'), value = {b:2,a:1}
  assert.equal(canonical(value),'{"a":1,"b":2}')
  const signature = signDocument('offer',value,key.privateKey)
  verifyDocument('offer',value,signature,key.publicKey)
  assert.throws(() => verifyDocument('payment',value,signature,key.publicKey),/invalid_signature/)
  assert.deepEqual(decodeHeader(encodeHeader(value)),value)
  assert.throws(() => decodeHeader('x'.repeat(30000)),/invalid_header/)
  const encrypted = encryptResource(Buffer.from('secret'),response.publicKey,hash(value))
  assert.equal(decryptResource(encrypted,response.privateKey,hash(value)).toString(),'secret')
  assert.throws(() => decryptResource(encrypted,response.privateKey,'0'.repeat(64)))
})
test('mainnet offers and direct remote regtest transport are refused', async () => {
  const h = harness()
  try {
    const id = nonce(); await h.client().purchase(h.url,{purchaseId:id})
    assert.throws(() => validateOffer({...h.store.get(`agent:${id}`).offer,network:'zcash:mainnet'}),/unsupported_profile/)
    assert.throws(() => regtestTransport()('https://example.com',{headers:{}}),/regtest_loopback_required/)
    assert.throws(() => torTransport({proxy:'socks5://127.0.0.1:9050'}),/invalid_tor_proxy/)
    await assert.rejects(torTransport({proxy:'socks5h://127.0.0.1:1',timeoutMs:1000})('https://example.com',{headers:{},purchaseId:nonce()}),/transport_failed/)
  } finally { h.close() }
})
