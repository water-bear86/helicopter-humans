import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AgentClient, NativeWallet, PrivateStore, identity, nonce, regtestTransport, verifyReceipt } from '../packages/z402/index.js'
import { startMerchant } from '../examples/z402/merchant.mjs'

assert.equal(process.env.Z402_REGTEST, '1', 'Set Z402_REGTEST=1 to authorize local regtest transactions.')
const nativeConfigFile = resolve(process.argv[2] || '.z402-local/agent-native.json')
const evidenceFile = resolve(process.argv[3] || '.z402-local/evidence.json')
const config = JSON.parse(readFileSync(nativeConfigFile,'utf8'))
assert.equal(config.network,'zcash:regtest')
const directory = resolve('.z402-local')
mkdirSync(directory,{recursive:true,mode:0o700})
const binary = resolve('tools/z402-wallet/target/debug/z402-wallet')
const url = 'http://127.0.0.1:4042/report'
const save = (path,value) => writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600})
const identityFile = join(directory,'merchant-identity.json'), keyFile = join(directory,'storage-key.hex'), resourceFile = join(directory,'report.txt')
if (!existsSync(identityFile)) save(identityFile,identity())
if (!existsSync(keyFile)) writeFileSync(keyFile,randomBytes(32).toString('hex'),{mode:0o600})
writeFileSync(resourceFile,'z402 live regtest: private payment, independently verified receipt.\n',{mode:0o600})
const merchantKey = JSON.parse(readFileSync(identityFile,'utf8')).publicKey
config.merchants[new URL(url).origin] = merchantKey
save(nativeConfigFile,config)
const native = new NativeWallet({binary,configFile:nativeConfigFile})
async function awaitIndexer() {
  for(let attempt=0;attempt<60;attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:29106/readyz')
      const status = await response.json()
      const tipResponse = await fetch(config.zebra,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getblockcount',params:[]})})
      const tip = await tipResponse.json()
      if (response.ok && !tip.error && status.current_height === status.target_height && status.current_height === tip.result) {
        const ready = await native.preflight()
        if (ready.visibleHeight === tip.result) return ready
      }
    } catch { /* Local node startup and catch-up are bounded below. */ }
    await new Promise(resolve => setTimeout(resolve,500))
  }
  throw new Error('local indexer did not converge')
}
await awaitIndexer()
// Repeated live runs also need the native wallet's trusted-change confirmations.
for(let index=0;index<3;index++) { await mine(); await awaitIndexer() }
const ready = await awaitIndexer()
const merchantNativeFile = join(directory,'merchant-native.json')
const merchantWalletDir = join(directory,'merchant-wallet')
save(merchantNativeFile,{...config,walletDir:merchantWalletDir,merchants:{}})
const merchantNative = new NativeWallet({binary,configFile:merchantNativeFile})
const addressFile = join(directory,'merchant-address.json')
if (!existsSync(addressFile)) save(addressFile,existsSync(join(merchantWalletDir,'seed.age')) ? await merchantNative.call('address') : await merchantNative.call('init',{birthdayHeight:ready.visibleHeight + 1}))
const merchantConfig = {binary,nativeConfig:merchantNativeFile,database:join(directory,'merchant.sqlite'),storageKeyFile:keyFile,identityFile,resourceFile,url,network:config.network,payTo:JSON.parse(readFileSync(addressFile,'utf8')).address,amountZat:'50000'}
const merchant = startMerchant(merchantConfig)
await merchant.listen()
let store = new PrivateStore(join(directory,'agent.sqlite'),Buffer.from(readFileSync(keyFile,'utf8'),'hex'),{budgetZat:config.budgetZat})
const purchaseId = nonce()
const client = () => new AgentClient({store,native,transport:regtestTransport(),merchants:config.merchants,maxAmountZat:config.maxAmountZat,feeCapZat:config.feeCapZat})
async function mine() {
  const response = await fetch(config.zebra,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'generate',params:[1]})})
  const result = await response.json(); assert.equal(result.error,undefined)
}
let merchantClosed = false
try {
  let result = await client().purchase(url,{purchaseId})
  if (!Buffer.isBuffer(result)) {
    assert.equal(result.status,'pending'); await mine()
    for(let attempt=0;attempt<20;attempt++) {
      result = await client().purchase(url,{purchaseId})
      if (Buffer.isBuffer(result)) break
      await new Promise(resolve => setTimeout(resolve,500))
    }
  }
  assert.ok(Buffer.isBuffer(result),'payment did not reach mined settlement')
  assert.deepEqual(result,readFileSync(resourceFile))
  const saved = store.get(`agent:${purchaseId}`)
  await assert.rejects(native.sign({offer:saved.offer,offerSignature:saved.offerSignature,pcztHex:'00'}),'native signer accepted a modified proposal')
  await assert.rejects(native.submit({offer:saved.offer,offerSignature:saved.offerSignature,pcztHex:'00'}),'native submitter accepted changed signed bytes')
  await merchant.close(); merchantClosed = true
  store.close()
  store = new PrivateStore(join(directory,'agent.sqlite'),Buffer.from(readFileSync(keyFile,'utf8'),'hex'),{budgetZat:config.budgetZat})
  assert.deepEqual(await client().purchase(url,{purchaseId}),result)
  const verifierFile = join(directory,'independent-verifier.json')
  save(verifierFile,{...config,walletDir:join(directory,'unused-verifier-wallet'),merchants:{}})
  const independent = new NativeWallet({binary,configFile:verifierFile})
  const verified = await verifyReceipt(saved.receipt,{merchantKey,native:independent})
  assert.equal(verified.meetsConfirmationPolicy,true)
  await assert.rejects(verifyReceipt({...saved.receipt,proof:{...saved.receipt.proof,disclosureHex:'ab'}},{merchantKey,native:independent}))
  const statement = {version:1,environment:'local-regtest-only',profile:'zally-ironwood-v1',experimental:true,txid:saved.txid,chain:saved.receipt.chain,verification:verified,checks:['native shielded payment','purchase-bound native disclosure','merchant acknowledgment and encrypted delivery','retry after merchant shutdown and client restart','independent native verification without payer seed','tampered disclosure rejected','native signer and submitter reject modified PCZTs'],amountZat:saved.offer.amountZat,feeZat:saved.feeZat}
  save(evidenceFile,statement)
  save(join(directory,'receipt.json'),saved.receipt)
  console.log(JSON.stringify(statement,null,2))
} finally { if(!merchantClosed) await merchant.close(); store.close() }
