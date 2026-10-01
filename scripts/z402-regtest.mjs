import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { NativeWallet } from '../packages/z402/index.js'

assert.equal(process.platform,'darwin','The bootstrap currently supports macOS; see the native runbook for Linux parameters.')
const directory = resolve('.z402-local'), helper = 'z402-regtest-config-writer', volume = 'z402-regtest-config'
mkdirSync(directory,{recursive:true,mode:0o700})
assert.equal(lstatSync(directory).mode & 0o077,0,'private local directory required')
const save = (path,value) => writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600})
const run = (binary,args,options={}) => execFileSync(binary,args,{stdio:'inherit',...options})
const image = 'zfnd/zebra:6.2.3@sha256:bb2a6029db277ee3a10e951dcc0ddd36b4cbcbe0fad684746d695ee21d53fde2'
run('docker',['info','--format','Docker {{.ServerVersion}}'])
run('cargo',['build','--locked','--manifest-path','tools/z402-wallet/Cargo.toml'])
try { execFileSync('docker',['image','inspect',image],{stdio:'ignore'}) }
catch { run('docker',['pull',image]) }
run('docker',['volume','create',volume])
try { execFileSync('docker',['container','inspect',helper],{stdio:'ignore'}) }
catch { run('docker',['create','--name',helper,'--label','com.helicopter-humans.z402=true','--entrypoint','/bin/true','-v',`${volume}:/config`,image]) }
const label = execFileSync('docker',['inspect','--format','{{index .Config.Labels "com.helicopter-humans.z402"}}',helper],{encoding:'utf8'}).trim()
assert.equal(label,'true','configuration helper belongs to another operator')
for(const file of ['zebrad.toml','ingest.toml','projector.toml','query.toml']) run('docker',['cp',resolve('examples/z402/regtest',file),`${helper}:/config/${file}`])
for(const file of ['ingest.token','checkpoint.token']) {
  const path = join(directory,file)
  if(!existsSync(path)) writeFileSync(path,randomBytes(32).toString('hex'),{mode:0o600})
  run('docker',['cp',path,`${helper}:/config/${file}`])
}
run('docker',['run','--rm','--user','0','--entrypoint','/bin/sh','-v',`${volume}:/config`,image,'-c','chown -R 1000:1000 /config && chmod 600 /config/*.token'])
const minerFile = join(directory,'miner.json')
const environment = {...process.env}
if(existsSync(minerFile)) environment.Z402_MINER_ADDRESS = JSON.parse(readFileSync(minerFile,'utf8')).address
const compose = args => run('docker',['compose','-f','examples/z402/compose.yaml',...args],{env:environment})
async function rpc(method,params=[]) {
  const response = await fetch('http://127.0.0.1:29232',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})
  assert.ok(response.ok); const result = await response.json(); assert.ok(!result.error); return result.result
}
async function until(check,label) {
  for(let attempt=0;attempt<120;attempt++) {
    try { if(await check()) return } catch { /* Startup and catch-up have a fixed deadline. */ }
    await new Promise(resolve => setTimeout(resolve,1000))
  }
  throw new Error(`${label} did not become ready within 120 seconds`)
}
compose(['up','-d','zebra'])
await until(async () => Boolean(await rpc('getblockchaininfo')),'Zebra')
const chain = await rpc('getblockchaininfo')
assert.equal(chain.upgrades['37a5165b'].activationheight,2,'expected NU6.3 regtest activation at height 2')
if(chain.blocks < 2) await rpc('generate',[2-chain.blocks])
const configFile = join(directory,'agent-native.json')
if(!existsSync(configFile)) save(configFile,{network:'zcash:regtest',walletDir:join(directory,'payer-wallet'),zinder:'http://127.0.0.1:29102',zebra:'http://127.0.0.1:29232',paramsDir:join(directory,'params','ZcashParams'),maxAmountZat:'1000000',feeCapZat:'100000',budgetZat:'10000000',merchants:{}})
const config = JSON.parse(readFileSync(configFile,'utf8'))
assert.equal(config.network,'zcash:regtest')
const binary = resolve('tools/z402-wallet/target/debug/z402-wallet')
run(binary,['--config',configFile,'params'],{input:'{}',stdio:['pipe','inherit','inherit']})
async function indexers() {
  compose(['up','-d','--force-recreate','ingest','projector','query'])
  await until(async () => {
    const response = await fetch('http://127.0.0.1:29106/readyz'); if(!response.ok) return false
    const ready = await response.json(); return ready.current_height === ready.target_height && ready.current_height === (await rpc('getblockchaininfo')).blocks
  },'WalletQuery')
}
await indexers()
const native = new NativeWallet({binary,configFile})
if(!existsSync(join(config.walletDir,'seed.age'))) {
  await native.preflight(); await native.call('init',{birthdayHeight:2})
}
await native.call('sync')
if(!existsSync(minerFile)) {
  const result = JSON.parse(execFileSync(binary,['--config',configFile,'regtest-funding-address'],{input:'{}',encoding:'utf8'}))
  assert.equal(result.ok,true); save(minerFile,result.result)
}
environment.Z402_MINER_ADDRESS = JSON.parse(readFileSync(minerFile,'utf8')).address
const fundedFile = join(directory,'funded.json')
if(!existsSync(fundedFile)) {
  console.log('Mining synthetic regtest coins while indexers are stopped.')
  compose(['stop','query','projector','ingest'])
  compose(['up','-d','zebra'])
  await until(async () => Boolean(await rpc('getblockchaininfo')),'Zebra')
  await rpc('generate',[110])
  await indexers()
  const funded = JSON.parse(execFileSync(binary,['--config',configFile,'regtest-shield'],{input:JSON.stringify({id:'z402-regtest-bootstrap-v1'}),encoding:'utf8',maxBuffer:4_194_304}))
  assert.equal(funded.ok,true)
  // Funded notes need the upstream wallet's default confirmation policy.
  for(let index=0;index<11;index++) { await rpc('generate',[1]); await until(async () => { const ready=await (await fetch('http://127.0.0.1:29106/readyz')).json(); return ready.status==='ready' && ready.current_height===(await rpc('getblockchaininfo')).blocks },'funding confirmations') }
  await native.call('sync')
  save(fundedFile,funded.result)
}
console.log('Private regtest wallet ready. Run Z402_REGTEST=1 npm run test:z402:live')
