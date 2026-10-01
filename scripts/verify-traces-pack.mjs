// Installs outside the repository. No checkout modules or Python are used by the installed executable.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const archive = resolve(process.argv[2] ?? 'dist/expose402-0.1.0.tgz')
const directory = mkdtempSync(join(tmpdir(), 'hh-clean-install-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const evidence = { platform: process.platform, arch: process.arch, node: process.version, outsideRepository: true, checks: [] }
try {
  const install = spawnSync(npm, ['install', '--prefix', directory, '--cache', join(directory, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', archive], { encoding: 'utf8', timeout: 60_000, shell: process.platform === 'win32' })
  assert.equal(install.status, 0, install.stderr)
  const root = join(directory, 'node_modules', 'expose402')
  const metadata = JSON.parse(readFileSync(join(root, 'package.json')))
  assert.equal(metadata.name, 'expose402')
  assert.equal(metadata.version, '0.1.0')
  assert.equal(metadata.engines.node, '>=24.0.0')
  assert.equal(Object.keys(metadata.dependencies ?? {}).length, 0)
  evidence.checks.push('clean archive install; metadata; zero runtime dependencies')
  const nodeOnly = join(directory, 'node-only'); mkdirSync(nodeOnly)
  if (process.platform !== 'win32') symlinkSync(process.execPath, join(nodeOnly, 'node'))
  const entry = join(root, 'bin', 'expose402.js')
  const env = { ...process.env, ...(process.platform === 'win32' ? {} : { PATH: nodeOnly }) }
  // PATH has only Node on macOS/Linux. There is no globally installed Python or sqlite executable to fall back to.
  const invoke = (args, input = '') => {
    const executable = process.platform === 'win32' ? process.execPath : join(directory, 'node_modules', '.bin', 'expose402')
    const commandArgs = process.platform === 'win32' ? [entry, ...args] : args
    const result = spawnSync(executable, commandArgs, { cwd: directory, env, input, encoding: 'utf8', timeout: 15_000 })
    assert.equal(result.status, 0, result.stderr || String(result.error))
    return result.stdout
  }
  assert.match(invoke(['--help']), /ENTIRE saved history/)
  assert.equal(invoke(['--version']).trim(), '0.1.0')
  assert.match(invoke(['--demo', '--preview']), /INVENTED DEMO/)
  assert.match(invoke(['--demo'], '1\nyes\nDELETE-SELECTED-THREADS\n'), /Removed 1 entire/)
  evidence.checks.push('installed bin entrypoint; help; version; invented demo preview and confirmed removal')
  const { createDemo } = await import(pathToFileURL(join(root, 'lib', 'cli.js')))
  const { preview, summary } = await import(pathToFileURL(join(root, 'lib', 'store.js')))
  const store = join(directory, 'checkpoints.sqlite'); createDemo(store)
  const before = readFileSync(store)
  assert.match(invoke(['--discover']), /Candidate files only/)
  assert.match(invoke([], '1\n\n'), /Cancelled/)
  assert.match(invoke(['--store', store, '--preview']), /Preview complete/)
  for (const input of ['', '\n', 'q\n', '1\nno\n', '1\nyes\nno\n']) assert.match(invoke(['--store', store], input), /Cancelled/)
  assert.deepEqual(readFileSync(store), before)
  evidence.checks.push('bounded discovery; chosen-store preview; empty/EOF/q/stopped-agent/confirmation cancellation; unchanged file')
  assert.match(invoke(['--store', store], '1\nyes\nDELETE-SELECTED-THREADS\n'), /Removed 1 entire/)
  assert.equal(summary(preview(store)).length, 1)
  evidence.checks.push('installed confirmed deletion; unselected thread remains')
  evidence.nodeOnlyPath = process.platform !== 'win32'
  if (process.argv[3]) writeFileSync(resolve(process.argv[3]), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
} finally { rmSync(directory, { recursive: true, force: true }) }
