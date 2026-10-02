import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { NativeWallet, PrivateStore, createMerchant } from '../../packages/z402/index.js'

export function startMerchant(config) {
  const store = new PrivateStore(config.database, Buffer.from(readFileSync(config.storageKeyFile, 'utf8').trim(), 'hex'))
  const native = new NativeWallet({ binary: config.binary, configFile: config.nativeConfig })
  const handle = createMerchant({ identity: JSON.parse(readFileSync(config.identityFile, 'utf8')), store, native, network: config.network, payTo: config.payTo, resources: { [config.url]: { amountZat: config.amountZat, read: async () => readFileSync(config.resourceFile) } } })
  const url = new URL(config.url)
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('example requires loopback HTTP; use a TLS reverse proxy for remote merchants')
  const server = createServer({maxHeaderSize:32_768},async (req, res) => {
    if (req.headers.host !== url.host) { res.writeHead(400); res.end(); return }
    try {
      const result = await handle(new Request(new URL(req.url, url.origin), { method: req.method, headers: req.headers }))
      res.writeHead(result.status, Object.fromEntries(result.headers))
      res.end(Buffer.from(await result.arrayBuffer()))
    } catch { res.writeHead(503); res.end() }
  })
  server.requestTimeout = 30_000; server.headersTimeout = 10_000
  return { server, store, listen: () => new Promise((resolve,reject) => { server.once('error',reject); server.listen(Number(url.port),'127.0.0.1',resolve) }), close: () => new Promise(resolve => server.close(() => { store.close(); resolve() })) }
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'))
  const merchant = startMerchant(config); await merchant.listen()
  console.log(`Regtest merchant listening at ${config.url}`)
}
