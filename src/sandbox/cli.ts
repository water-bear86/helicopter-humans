// Entry point for `npm run sandbox -- <command>`. Built by vite.tools.config.ts; see docs/SANDBOX_TEST.md.
//   preflight [--offline]         read-only readiness report; exit 1 unless every check passes
//   create --confirm-testnet      preflight, then one testnet order and invoice (never mainnet)
//   refresh                       preflight, then one provider read of that sandbox order; prints evidence
//   check-tx                      reads `getrawtransaction <txid> 1` JSON on stdin; offline Orchard-only policy check
import { resolve } from 'node:path'
import { runSandboxCommand } from './commands.js'

const [command = 'preflight', ...flags] = process.argv.slice(2)
const orderFile = resolve(process.env.SANDBOX_ORDER_FILE ?? '.sandbox-local/order.json')

try {
  process.exitCode = await runSandboxCommand(command, flags, { env: process.env, orderFile })
} catch (error) {
  // Only this tool's own messages are printed. Driver errors can name hosts or users, so only their
  // class and code are shown.
  const own = error instanceof Error && /^an order file/.test(error.message)
  const code = (error as { code?: unknown }).code
  console.error(`sandbox ${command} failed: ${own ? (error as Error).message : `${error instanceof Error ? error.name : 'error'}${typeof code === 'string' ? ` ${code}` : ''}`}`)
  process.exitCode = 1
}
