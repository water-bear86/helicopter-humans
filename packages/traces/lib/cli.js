// SPDX-License-Identifier: MIT
import { createInterface } from 'node:readline'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { lstatSync, mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { preview, summary, removeSelected, recover, Refusal, SCHEMA } from './store.js'

export const VERSION = '0.1.0'
const HELP = `Helicopter Humans traces ${VERSION}
Guided, local payment-trace discovery. Starts with a read-only preview.

hh-traces                 Find conventional history files and choose one
hh-traces --demo          Try clearly invented history (never your real data)
hh-traces --store PATH    Choose a local LangGraph history file
hh-traces --preview       Stop after the read-only summary
hh-traces --discover      List candidate locations without opening stores
hh-traces --recover FILE --store PATH
                          Check whether an interrupted removal applied
hh-traces --help | --version

Requires Node.js 24+. No Python, account, wallet, payment, telemetry or upload.
Supported: LangGraph SqliteSaver 3.1.1 two-table SQLite layout. Searches are
bounded, nonrecursive filename checks. Other agent stores are not supported.
Matches are candidates, not proof of payment. Secret values and raw thread IDs
are never printed. Removal deletes each selected thread's ENTIRE saved history,
including checkpoints and pending writes across its namespaces. Stop your agent,
choose threads, review the impact, then type DELETE-SELECTED-THREADS to confirm.
Empty selection, cancellation and preview never delete data. Removal is not an
undo, a secure disk wipe, or erasure of provider, blockchain or backup records.
Recovery receipts only establish whether a transaction applied; they contain
no saved trace content. See the bundled README for limits and supported paths.
`
export function conventionalPaths({ cwd = process.cwd(), home = homedir(), platform = process.platform, localAppData = process.env.LOCALAPPDATA } = {}) {
  const path = platform === 'win32' ? win32 : { join, resolve }
  const locations = ['checkpoints.sqlite', 'checkpoints.db', 'langgraph.sqlite', 'langgraph.db', '.langgraph/checkpoints.sqlite', '.langgraph/checkpoints.db'].map(name => path.resolve(cwd, name))
  locations.push(path.join(home, '.langgraph', 'checkpoints.sqlite'), path.join(home, '.langgraph', 'checkpoints.db'))
  if (platform === 'win32' && localAppData) locations.push(path.join(localAppData, 'LangGraph', 'checkpoints.sqlite'))
  return [...new Set(locations)]
}
export function discover(options) {
  return conventionalPaths(options).filter(path => { try { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink() } catch { return false } })
}
export function createDemo(path) {
  const db = new DatabaseSync(path)
  try {
    db.exec(Object.values(SCHEMA).join(';'))
    const checkpoint = db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, NULL, ?, ?, ?)')
    checkpoint.run('invented-payment', '', 'c1', 'json', Buffer.from('{"x402Version":2,"PAYMENT-SIGNATURE":"INVENTED-NOT-A-CREDENTIAL"}'), Buffer.from('{}'))
    checkpoint.run('invented-payment', 'subgraph', 'c2', 'json', Buffer.from('{"PAYMENT-RESPONSE":"invented"}'), Buffer.from('{}'))
    checkpoint.run('invented-ordinary', '', 'c3', 'json', Buffer.from('{"task":"invented grocery list"}'), Buffer.from('{}'))
    db.prepare('INSERT INTO writes VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('invented-payment', '', 'c1', 'task', 0, 'result', 'json', Buffer.from('{"payment_receipt":"invented"}'))
  } finally { db.close() }
}
export async function run(argv = process.argv.slice(2), { input = process.stdin, output = process.stdout, errorOutput = process.stderr } = {}) {
  const say = text => output.write(text + '\n')
  let lines, demoDirectory
  try {
    const flags = {}
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]
      if (['--store', '--recover'].includes(flag)) {
        if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Refusal('Provide a path after --store or --recover. Use --help for examples.')
        flags[flag] = argv[++i]
      } else if (['--help', '--version', '--demo', '--preview', '--discover'].includes(flag)) flags[flag] = true
      else throw new Refusal('Unknown option. Use --help to see the supported commands; no changes were made.')
    }
    if (flags['--help']) { say(HELP); return 0 }
    if (flags['--version']) { say(VERSION); return 0 }
    if (flags['--demo'] && (flags['--store'] || flags['--recover'])) throw new Refusal('Choose either an invented demo or a real store, not both.')
    if (flags['--recover']) {
      if (!flags['--store']) throw new Refusal('Recovery needs the original --store path and --recover receipt file. It does not delete anything.')
      say(`Read-only recovery check: ${recover(flags['--store'], flags['--recover'])}.`)
      return 0
    }
    const found = flags['--store'] || flags['--demo'] ? [] : discover()
    if (flags['--discover']) {
      say('Candidate files only; no history opened. These filenames are guesses, not a LangGraph default.')
      found.forEach((path, i) => say(`${i + 1}. ${JSON.stringify(path)}`))
      if (!found.length) say('No candidates found. Use --demo, or --store followed by the history path configured in your agent app.')
      return 0
    }
    say('HELICOPTER HUMANS / LOCAL TRACE DISCOVERY')
    say('No account, wallet, payment, telemetry or upload. Nothing is removed during discovery.')
    lines = createInterface({ input, crlfDelay: Infinity, terminal: false })
    const iterator = lines[Symbol.asyncIterator]()
    const ask = async text => {
      output.write(text + ' ')
      const next = await iterator.next()
      if (next.done) return ''
      if (next.value.length > 4096) throw new Refusal('Input is too long. Start again with a short choice; nothing was removed.')
      return next.value.trim()
    }
    let store = flags['--store']
    let demo = flags['--demo']
    if (!store && !demo) {
      if (found.length) {
        say('Possible history files (only the file you choose will be opened):')
        found.forEach((path, i) => say(`${i + 1}. ${JSON.stringify(path)}`))
      } else say('No conventional history file found. LangGraph apps can save history anywhere; ask your app owner for its configured history path.')
      const choice = await ask('Choose a file number, p to enter its path, d for an INVENTED DEMO, or Enter to cancel:')
      if (choice.toLowerCase() === 'd') demo = true
      else if (choice.toLowerCase() === 'p') store = await ask('Local history file path (no surrounding quotes), or Enter to cancel:')
      else if (/^\d+$/.test(choice) && found[Number(choice) - 1]) store = found[Number(choice) - 1]
      else if (choice && choice.toLowerCase() !== 'q') throw new Refusal('Choose one of the listed options. No history was opened or removed.')
    }
    if (demo) {
      say('INVENTED DEMO: every thread and payment marker below is fictional. This is not your history.')
      demoDirectory = mkdtempSync(join(tmpdir(), 'hh-traces-demo-'))
      store = join(demoDirectory, 'invented.sqlite')
      createDemo(store)
    }
    if (!store) { say('Cancelled. Nothing removed.'); return 0 }
    const plan = preview(store)
    const threads = summary(plan)
    say(`Supported source: LangGraph SqliteSaver 3.1.1${demo ? ' / INVENTED DEMO' : ''}.`)
    say(`Preview: ${threads.length} saved thread(s). IDs and saved content stay hidden; labels apply only to this preview.`)
    const matching = threads.filter(thread => Object.keys(thread.matches).length)
    for (const [index, thread] of matching.entries()) {
      const total = Object.values(thread.matches).reduce((n, count) => n + count, 0)
      say(`${index + 1}. ${thread.label} — ${total} candidate match(es); ${thread.checkpoints} saved checkpoint(s), ${thread.writes} pending write(s).`)
      say(`   Candidate categories: ${Object.keys(thread.matches).join(', ')}.`)
    }
    say('Candidates can be false positives. This is not a full privacy audit or verification of payment.')
    if (!matching.length) { say('No candidate matches found. Nothing removed. You can try --demo for the guided example.'); return 0 }
    if (flags['--preview']) { say('Preview complete. Nothing removed.'); return 0 }
    say('Removal deletes the selected threads\' ENTIRE saved history, across all their namespaces. Other threads stay saved.')
    say('This cannot be undone by this tool. Existing backups, provider records and blockchain records are unaffected.')
    const choice = await ask('Select thread numbers separated by commas, or Enter/q to cancel:')
    if (!choice || choice.toLowerCase() === 'q') { say('Cancelled. Nothing removed.'); return 0 }
    const indexes = choice.split(',').map(value => value.trim())
    if (indexes.some(value => !/^\d+$/.test(value) || !matching[Number(value) - 1]) || new Set(indexes.map(Number)).size !== indexes.length) throw new Refusal('Select distinct numbers from this preview. No removal was started.')
    const selected = indexes.map(index => matching[Number(index) - 1])
    say(`Impact: ${selected.length} entire thread(s), ${selected.reduce((n, t) => n + t.checkpoints, 0)} checkpoint(s) and ${selected.reduce((n, t) => n + t.writes, 0)} pending write(s) will be removed.`)
    say(`Selected: ${selected.map(thread => thread.label).join(', ')}.`)
    if ((await ask('Has the agent using this history been stopped? Type yes to continue:')).toLowerCase() !== 'yes') { say('Cancelled. Stop the agent before cleanup. Nothing removed.'); return 0 }
    if (await ask('Type DELETE-SELECTED-THREADS to confirm removal, or Enter to cancel:') !== 'DELETE-SELECTED-THREADS') { say('Cancelled. Nothing removed.'); return 0 }
    const result = removeSelected(plan, selected.map(thread => thread.label))
    say(`Removed ${result.threads} entire selected thread(s). Unselected threads were preserved.`)
    say(demo ? 'Invented demo finished. Its temporary files will be discarded.' : `Operation receipt: ${JSON.stringify(result.receiptPath)}. Use --recover FILE --store PATH to check an interrupted operation; recovery is not undo.`)
    return 0
  } catch (error) {
    errorOutput.write((error instanceof Refusal ? error.message : 'Could not complete this operation safely. Check local file and folder access, then start a fresh preview.') + '\n')
    return 1
  } finally {
    lines?.close()
    if (demoDirectory) rmSync(demoDirectory, { recursive: true, force: true })
  }
}
