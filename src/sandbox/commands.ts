// The sandbox commands, with their dependencies injectable so the guards can be tested. cli.ts is the
// process entry point.
//
// Every command that opens the order store (create, refresh) first passes the same full preflight:
// local runtime, testnet network, disposable sandbox database with the testnet-only schema, and a
// healthy testnet provider. The preflight contacts nothing external until its local checks pass, and
// refresh validates its order file before that. On a local refusal no store is opened.
//
// refresh runs in this order: order file metadata, local configuration, read-only schema check, the
// loaded order's identity, and only then provider health and the invoice read. A missing or
// non-sandbox order is refused with no provider access of any kind and no store change.
import { existsSync, readFileSync } from 'node:fs'
import type { Env } from '../checkout/readiness.js'
import { checkShieldedTransaction, createTestnetOrder, loadSandboxOrder, readOrderFile, refreshTestnetOrder, SandboxRefusal, testnetDeps, type HarnessDeps } from './harness.js'
import { runPreflight, type Check, type PreflightReport, type PreflightStages } from './preflight.js'

export interface CommandIo {
  env: Env
  orderFile: string
  // Must pass `stages` on to runPreflight; refresh refuses to continue if its order check did not run.
  preflight?: (env: Env, stages?: PreflightStages) => Promise<PreflightReport>
  makeDeps?: (env: Env, orderFile: string) => HarnessDeps
  readStdin?: () => string
  out?: (line: string) => void
  err?: (line: string) => void
}

export async function runSandboxCommand(command: string, flags: string[], io: CommandIo): Promise<number> {
  const out = io.out ?? console.log
  const err = io.err ?? console.error
  const preflight = io.preflight ?? ((env: Env, stages?: PreflightStages) => runPreflight(env, stages))
  const makeDeps = io.makeDeps ?? testnetDeps

  const printReport = (report: PreflightReport) => {
    out(`CipherPay sandbox preflight (${report.network}, ${report.providerOrigin})`)
    for (const c of report.checks) out(`  [${c.status.toUpperCase().padEnd(7)}] ${c.id}: ${c.detail}`)
    out('Operator confirmations (not checked by this tool):')
    for (const line of report.operatorConfirmations) out(`  - ${line}`)
    out(report.ready ? 'READY.' : 'NOT READY. No order was created or changed, and no invoice was read from the provider.')
  }

  // Runs `use` only after `local` (a check with no external access) and a passing preflight, and
  // always closes the store it opened. `checkOrder`, if given, runs inside the preflight after the
  // schema check and before the provider is contacted; the store is opened only when it runs.
  const gated = async (use: (deps: HarnessDeps) => Promise<void>, local: () => void = () => undefined, checkOrder?: (deps: HarnessDeps) => Promise<void>): Promise<number> => {
    try {
      local()
    } catch (error) {
      if (!(error instanceof SandboxRefusal)) throw error
      err(`refused: ${error.message}. Neither the database nor the provider was contacted.`)
      return 1
    }
    let deps: HarnessDeps | undefined
    const open = () => (deps ??= makeDeps(io.env, io.orderFile))
    let orderChecked = false
    const beforeProvider = async (): Promise<Check> => {
      try {
        await checkOrder!(open())
        orderChecked = true
        return { id: 'order_identity', status: 'pass', detail: 'the loaded order is a sandbox testnet order' }
      } catch (error) {
        if (!(error instanceof SandboxRefusal)) throw error
        return { id: 'order_identity', status: 'fail', detail: `refused: ${error.message}` }
      }
    }
    try {
      const report = await preflight(io.env, checkOrder && { beforeProvider })
      printReport(report)
      if (!report.ready) return 1
      if (checkOrder && !orderChecked) {
        err('refused: the preflight did not check the loaded order before the provider. No invoice was read and nothing was changed.')
        return 1
      }
      await use(open())
      return 0
    } catch (error) {
      if (!(error instanceof SandboxRefusal)) throw error
      err(`refused: ${error.message}. No invoice was read from the provider and nothing was changed.`)
      return 1
    } finally {
      await deps?.store.close?.()
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
      }, () => {
        if (existsSync(io.orderFile)) throw new SandboxRefusal(`an order file already exists (${io.orderFile}); one attempt per file, refresh it or remove it deliberately`)
      })
    case 'refresh':
      return gated(
        async (deps) => out(JSON.stringify(await refreshTestnetOrder(deps), null, 2)),
        () => void readOrderFile(io.orderFile),
        async (deps) => void (await loadSandboxOrder(deps)),
      )
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
