import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { NativeWallet, verifyReceipt } from '../../packages/z402/index.js'

const [binary, configFile, receiptFile, merchantKeyFile] = process.argv.slice(2)
if (!binary || !configFile || !receiptFile || !merchantKeyFile) {
  throw new Error('usage: node examples/z402/verify-receipt.mjs BINARY NATIVE_CONFIG RECEIPT MERCHANT_KEY_FILE')
}
try {
  if (statSync(receiptFile).size > 524_288 || statSync(merchantKeyFile).size > 1024) throw new Error('input too large')
  const receipt = JSON.parse(readFileSync(receiptFile, 'utf8'))
  const merchantKey = readFileSync(merchantKeyFile, 'utf8').trim()
  const native = new NativeWallet({ binary: resolve(binary), configFile: resolve(configFile) })
  const result = await verifyReceipt(receipt, { merchantKey, native })
  console.log(JSON.stringify(result, null, 2))
  if (!result.meetsConfirmationPolicy) process.exitCode = 2
} catch {
  console.error('Receipt verification refused; check the authenticated merchant key, receipt, local node, and parameters.')
  process.exitCode = 1
}
