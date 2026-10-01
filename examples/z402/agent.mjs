import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentClient, NativeWallet, PrivateStore, torTransport, regtestTransport } from '../../packages/z402/index.js'

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const [url,purchaseId,outputFile] = process.argv.slice(3)
if (!url || !purchaseId || !outputFile) throw new Error('usage: node examples/z402/agent.mjs config.json URL PURCHASE_ID OUTPUT_FILE')
const store = new PrivateStore(config.database,Buffer.from(readFileSync(config.storageKeyFile,'utf8').trim(),'hex'),{budgetZat:config.budgetZat})
try {
  const client = new AgentClient({store,native:new NativeWallet({binary:config.binary,configFile:config.nativeConfig}),transport:config.network === 'zcash:regtest' ? regtestTransport() : torTransport({proxy:config.torProxy}),merchants:config.merchants,maxAmountZat:config.maxAmountZat,feeCapZat:config.feeCapZat})
  const result = await client.purchase(url,{purchaseId})
  if (Buffer.isBuffer(result)) { writeFileSync(resolve(outputFile),result,{mode:0o600}); console.log('Resource saved; receipt retained in the encrypted purchase journal.') }
  else { console.log(JSON.stringify(result)); process.exitCode = 2 }
} finally { store.close() }
