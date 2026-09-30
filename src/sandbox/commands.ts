// The sandbox commands, with their dependencies injectable so the guards can be tested. cli.ts is the
// process entry point.
//
// Every command that opens the order store (create, refresh) first passes the same full preflight:
// local runtime, testnet network, disposable sandbox database with the testnet-only schema, and a
// healthy testnet provider. On refusal no store is opened and the provider is never contacted.
import { readFileSync } from 'node:fs'
import type { Env } from '../checkout/readiness.js'
import { checkShieldedTransaction, createTestnetOrder, refreshTestnetOrder, SandboxRefusal, testnetDeps, type HarnessDeps } from './harness.js'
import { runPreflight, type PreflightReport } from './preflight.js'

export interface CommandIo {
  env: Env
  orderFile: string
  preflight?: (env: Env) => Promise<PreflightReport>
  makeDeps?: (env: Env, orderFile: string) => HarnessDeps
  readStdin?: () => string
  out?: (line: string) => void
  err?: (line: string) => void
}

export async function runSandboxCommand(command: string, flags: string[], io: CommandIo): Promise<number> {
  const out = io.out ?? console.log
  const err = io.err ?? console.error
  const preflight = io.preflight ?? ((env: Env) => runPreflight(env))
  const makeDeps = io.makeDeps ?? testnetDeps

  const printReport = (report: PreflightReport) => {
    out(`CipherPay sandbox preflight (${report.network}, ${report.providerOrigin})`)
    for (const c of report.checks) out(`  [${c.status.toUpperCase().padEnd(7)}] ${c.id}: ${c.detail}`)
    out('Operator confirmations (not checked by this tool):')
    for (const line of report.operatorConfirmations) out(`  - ${line}`)
    out(report.ready ? 'READY.' : 'NOT READY. No order was created, read or changed.')
  }

  // Runs `use` only after a passing preflight, and always closes the store it opened.
  const gated = async (use: (deps: HarnessDeps) => Promise<void>): Promise<number> => {
    const report = await preflight(io.env)
    printReport(report)
    if (!report.ready) return 1
    const deps = makeDeps(io.env, io.orderFile)
    try {
      await use(deps)
      return 0
    } catch (error) {
      if (!(error instanceof SandboxRefusal)) throw error
      err(`refused: ${error.message}. Nothing was read from the provider or changed.`)
      return 1
    } finally {
      await deps.store.close?.()
    }
  }

  switch (command) {
    case 'preflight': {
      const report = await runPreflight(io.env, { offline: flags.includes('--offline') })
      printReport(report)
      return report.ready ? 0 : 1
    }
    case 'create':
      if (!flags.includes('--confirm-testnet')) {
        err('create needs --confirm-testnet. It creates one testnet invoice; it cannot create a mainnet one.')
        return 2
      }
      return gated(async (deps) => {
        const { evidence, uri } = await createTestnetOrder(deps)
        out(`Recovery code saved to ${io.orderFile} (0600). It is not printed.`)
        if (uri) out(`Testnet payment URI (no monetary value): ${uri}`)
        out(JSON.stringify(evidence, null, 2))
      })
    case 'refresh':
      return gated(async (deps) => out(JSON.stringify(await refreshTestnetOrder(deps), null, 2)))
    case 'check-tx': {
      const read = io.readStdin ?? (() => readFileSync(0, 'utf8'))
      let tx: unknown
      try {
        tx = JSON.parse(read())
      } catch {
        tx = undefined
      }
      const result = checkShieldedTransaction(tx)
      out(JSON.stringify(result, null, 2))
      return result.fullyShielded ? 0 : 1
    }
    default:
      err(`unknown command: ${command}`)
      return 2
  }
}
