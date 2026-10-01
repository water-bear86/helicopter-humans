import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDemo, conventionalPaths, discover } from '../lib/cli.js'
import { preview, summary } from '../lib/store.js'

const entry = fileURLToPath(new URL('../bin/expose402.js', import.meta.url))
const invoke = (args, input = '', options = {}) => spawnSync(process.execPath, [entry, ...args], { input, encoding: 'utf8', timeout: 10_000, ...options })
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-cli-test-')), path = join(dir, 'checkpoints.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  createDemo(path)
  return { dir, path }
}
test('help/version and invented demo work without a store', () => {
  assert.match(invoke(['--help']).stdout, /ENTIRE saved history/)
  assert.equal(invoke(['--version']).stdout.trim(), '0.1.0')
  const demo = invoke(['--demo', '--preview'])
  assert.equal(demo.status, 0, demo.stderr)
  assert.match(demo.stdout, /INVENTED DEMO/)
  assert.match(demo.stdout, /Nothing removed/)
})
test('confirmed guided demo only affects invented files', () => {
  const result = invoke(['--demo'], '1\nyes\nDELETE-SELECTED-THREADS\n')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Removed 1 entire selected/)
  assert.match(result.stdout, /temporary files will be discarded/)
})
for (const [name, input] of Object.entries({ empty: '\n', quit: 'q\n', stopped: '1\nno\n', confirmation: '1\nyes\nno\n', eof: '' })) {
  test(`${name} cancellation does not delete or change the chosen store`, t => {
    const { path } = fixture(t), before = readFileSync(path)
    const result = invoke(['--store', path], input)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Cancelled/)
    assert.deepEqual(readFileSync(path), before)
  })
}
test('guided confirmed removal deletes selected thread, preserves unselected history', t => {
  const { path } = fixture(t)
  const result = invoke(['--store', path], '1\nyes\nDELETE-SELECTED-THREADS\n')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Impact: 1 entire thread\(s\), 2 checkpoint\(s\) and 1 pending write/)
  assert.match(result.stdout, /Removed 1 entire selected/)
  assert.equal(summary(preview(path)).length, 1)
})
test('discovery only checks documented exact paths, excludes deeper and unrelated files', t => {
  const { dir, path } = fixture(t)
  mkdirSync(join(dir, 'other'))
  writeFileSync(join(dir, 'other', 'checkpoints.sqlite'), 'must not inspect')
  writeFileSync(join(dir, 'unrelated.sqlite'), 'must not inspect')
  assert.deepEqual(discover({ cwd: dir, home: dir }), [path])
  const result = invoke(['--discover'], '', { cwd: dir })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /no history opened/)
  assert.doesNotMatch(result.stdout, /unrelated|other/)
})
test('automatic candidate selection enters preview and empty selection cancels', t => {
  const { dir, path } = fixture(t), before = readFileSync(path)
  const result = invoke([], '1\n\n', { cwd: dir })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Supported source/)
  assert.match(result.stdout, /Cancelled/)
  assert.deepEqual(readFileSync(path), before)
})
test('manual path fallback and invalid selections never silently remove', t => {
  const { dir, path } = fixture(t), before = readFileSync(path)
  for (const input of ['p\n' + path + '\nq\n', '1\n1,1\n', '1\n99\n']) {
    const result = invoke([], input, { cwd: dir })
    assert.ok(result.status === 0 || result.status === 1)
    assert.deepEqual(readFileSync(path), before)
  }
})
test('Windows/macOS/Linux conventional paths are finite and use platform separators', () => {
  const windows = conventionalPaths({ cwd: 'C:\\agent', home: 'C:\\Users\\person', platform: 'win32', localAppData: 'C:\\Users\\person\\AppData\\Local' })
  assert.equal(windows.length, 9)
  assert.equal(windows[0], 'C:\\agent\\checkpoints.sqlite')
  assert.equal(windows[8], 'C:\\Users\\person\\AppData\\Local\\LangGraph\\checkpoints.sqlite')
  assert.equal(conventionalPaths({ cwd: '/agent', home: '/home/person', platform: 'linux' }).length, 8)
})
test('unknown options, missing paths and unsupported files fail actionably', t => {
  const { dir } = fixture(t)
  assert.match(invoke(['--yes']).stderr, /Unknown option/)
  assert.match(invoke(['--store']).stderr, /Provide a path/)
  assert.match(invoke(['--store', join(dir, 'missing.sqlite')]).stderr, /Store not found/)
  const bad = join(dir, 'bad.sqlite'); writeFileSync(bad, 'INVENTED-SECRET-DO-NOT-ECHO')
  const result = invoke(['--store', bad])
  assert.equal(result.status, 1)
  assert.doesNotMatch(result.stderr + result.stdout, /INVENTED-SECRET-DO-NOT-ECHO/)
})
