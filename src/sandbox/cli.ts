// Entry point for `npm run sandbox -- <command>`. Built by vite.tools.config.ts; see docs/SANDBOX_TEST.md.
//   preflight [--offline]         read-only readiness report; exit 1 unless every check passes
//   create --confirm-testnet      preflight, then one testnet order and invoice (never mainnet)
//   refresh                       one provider read of that order; prints evidence
//   check-tx                      reads `getrawtransaction <txid> 1` JSON on stdin; checks it is fully shielded
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checkShieldedTransaction, createTestnetOrder, refreshTestnetOrder, testnetDeps } from './harness.js'
import { runPreflight, type PreflightReport } from './preflight.js'

const [command = 'preflight', ...flags] = process.argv.slice(2)
const orderFile = resolve(process.env.SANDBOX_ORDER_FILE ?? '.sandbox-local/order.json')

function printReport(report: PreflightReport) {
  console.log(`CipherPay sandbox preflight (${report.network}, ${report.providerOrigin})`)
  for (const c of report.checks) console.log(`  [${c.status.toUpperCase().padEnd(7)}] ${c.id}: ${c.detail}`)
  console.log('Operator confirmations (not checked by this tool):')
  for (const line of report.operatorConfirmations) console.log(`  - ${line}`)
  console.log(report.ready ? 'READY for one testnet invoice.' : 'NOT READY. Nothing was created.')
}

async function run(): Promise<number> {
  switch (command) {
    case 'preflight': {
      const report = await runPreflight(process.env, { offline: flags.includes('--offline') })
      printReport(report)
      return report.ready ? 0 : 1
    }
    case 'create': {
      if (!flags.includes('--confirm-testnet')) {
        console.error('create needs --confirm-testnet. It creates one testnet invoice; it cannot create a mainnet one.')
        return 2
      }
      const report = await runPreflight(process.env)
      printReport(report)
      if (!report.ready) return 1
      const deps = testnetDeps(process.env, orderFile)
      try {
        const { evidence, uri } = await createTestnetOrder(deps)
        console.log(`Recovery code saved to ${orderFile} (0600). It is not printed.`)
        if (uri) console.log(`Testnet payment URI (no monetary value): ${uri}`)
        console.log(JSON.stringify(evidence, null, 2))
      } finally {
        await deps.store.close?.()
      }
      return 0
    }
    case 'refresh': {
      const deps = testnetDeps(process.env, orderFile)
      try {
        console.log(JSON.stringify(await refreshTestnetOrder(deps), null, 2))
      } finally {
        await deps.store.close?.()
      }
      return 0
    }
    case 'check-tx': {
      const result = checkShieldedTransaction(JSON.parse(readFileSync(0, 'utf8')))
      console.log(JSON.stringify(result, null, 2))
      return result.fullyShielded ? 0 : 1
    }
    default:
      console.error(`unknown command: ${command}`)
      return 2
  }
}

try {
  process.exitCode = await run()
} catch (error) {
  // Only this tool's own messages are printed. Driver errors can name hosts or users, so only their
  // class and code are shown.
  const own = error instanceof Error && /^(an order file|order file has no)/.test(error.message)
  const code = (error as { code?: unknown }).code
  console.error(`sandbox ${command} failed: ${own ? (error as Error).message : `${error instanceof Error ? error.name : 'error'}${typeof code === 'string' ? ` ${code}` : ''}`}`)
  process.exitCode = 1
}
