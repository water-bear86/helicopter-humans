import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, linkSync, symlinkSync, copyFileSync, statSync, truncateSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preview, summary, removeSelected, recover, SCHEMA, LIMITS } from '../lib/store.js'
import { candidates, msgpackTexts } from '../lib/markers.js'

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-node-test-')), path = join(dir, 'history.sqlite')
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new DatabaseSync(path)
  db.exec(Object.values(SCHEMA).join(';'))
  const insert = db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, NULL, ?, ?, ?)')
  insert.run('secret-thread', '', 'old', 'json', Buffer.from('X-PAYMENT: invented-authorization'), Buffer.from('password=INVENTED-SECRET-12345'))
  insert.run('secret-thread', 'subgraph', 'new', 'json', Buffer.from('PAYMENT-RESPONSE: invented'), Buffer.from('{}'))
  insert.run('ordinary', '', 'keep', 'json', Buffer.from('no payment here'), Buffer.from('{}'))
  db.prepare('INSERT INTO writes VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('secret-thread', 'subgraph', 'new', 'task', 0, 'result', 'json', Buffer.from('payment_receipt=invented'))
  db.close()
  return { dir, path }
}
function edit(path, action) { const db = new DatabaseSync(path); try { return action(db) } finally { db.close() } }
function selected(plan) { return [...plan.handles].find(([_label, thread]) => thread.id === 'secret-thread')[0] }
const logical = path => edit(path, db => [db.prepare('SELECT * FROM checkpoints ORDER BY thread_id, checkpoint_ns, checkpoint_id').all(), db.prepare('SELECT * FROM writes ORDER BY thread_id').all()])

test('read-only preview finds old snapshots, subgraphs and pending writes without exposing content', t => {
  const { path, dir } = fixture(t), before = readFileSync(path)
  const report = summary(preview(path))
  assert.equal(report.length, 2)
  assert.equal(report[1].checkpoints, 2)
  assert.equal(report[1].writes, 1)
  assert.ok(report[1].matches['x402-authorization-marker'])
  assert.ok(report[1].matches['x402-settlement-marker'])
  assert.ok(report[1].matches['payment-receipt-marker'])
  assert.doesNotMatch(JSON.stringify(report), /secret-thread|INVENTED-SECRET|invented-authorization/)
  assert.deepEqual(readFileSync(path), before)
  assert.deepEqual(readdirSync(dir), ['history.sqlite'])
})
test('only selected entire thread is removed across namespaces; recoverable secret-free receipt', t => {
  const { path } = fixture(t), plan = preview(path)
  const retained = logical(path)[0].filter(row => row.thread_id === 'ordinary')
  const result = removeSelected(plan, [selected(plan)])
  assert.deepEqual(logical(path), [retained, []])
  assert.equal(recover(path, result.receiptPath), 'applied')
  const receipt = readFileSync(result.receiptPath, 'utf8')
  assert.doesNotMatch(receipt, /secret-thread|INVENTED-SECRET|invented-authorization/)
  assert.equal(JSON.parse(receipt).status, 'completed')
  if (process.platform !== 'win32') assert.equal(statSync(result.receiptPath).mode & 0o777, 0o600)
})
test('same-length content change makes a preview stale and cannot delete', t => {
  const { path } = fixture(t), plan = preview(path)
  edit(path, db => db.prepare('UPDATE checkpoints SET checkpoint=? WHERE checkpoint_id=?').run(Buffer.from('X-PAYMENT: invented-authorization'.replace('invented', 'modified')), 'old'))
  const before = logical(path)
  assert.throws(() => removeSelected(plan, [selected(plan)]), /changed since/)
  assert.deepEqual(logical(path), before)
})
test('same-content copy does not inherit a preview', t => {
  const { path, dir } = fixture(t), plan = preview(path), copy = join(dir, 'copy.sqlite')
  copyFileSync(path, copy)
  plan.path = copy
  assert.throws(() => removeSelected(plan, [selected(plan)]), /file changed/)
})
test('empty, duplicate and unknown selection cannot delete', t => {
  const { path } = fixture(t), plan = preview(path), before = logical(path)
  for (const labels of [[], ['thread-9999'], [selected(plan), selected(plan)]]) assert.throws(() => removeSelected(plan, labels), /distinct threads/)
  assert.deepEqual(logical(path), before)
})
test('late failure rolls back both tables, closes transaction and allows read-only recovery', t => {
  const { path, dir } = fixture(t), plan = preview(path), before = logical(path)
  assert.throws(() => removeSelected(plan, [selected(plan)], { beforeCommit() { throw new Error('injected failure') } }))
  assert.deepEqual(logical(path), before)
  edit(path, db => db.exec('BEGIN IMMEDIATE; ROLLBACK'))
  const receipt = join(dir, '.hh-traces-operations', readdirSync(join(dir, '.hh-traces-operations'))[0])
  assert.equal(recover(path, receipt), 'not-applied')
})
test('prepared receipt still checks a committed operation after interrupted receipt finalization', t => {
  const { path } = fixture(t), plan = preview(path), result = removeSelected(plan, [selected(plan)])
  const record = JSON.parse(readFileSync(result.receiptPath))
  record.status = 'prepared'
  writeFileSync(result.receiptPath, JSON.stringify(record))
  assert.equal(recover(path, result.receiptPath), 'applied')
  edit(path, db => db.prepare('UPDATE checkpoints SET metadata=?').run(Buffer.from('changed')))
  assert.equal(recover(path, result.receiptPath), 'changed-since-operation')
})
test('file replacement immediately before commit is refused and both-table deletion rolls back', t => {
  const { path, dir } = fixture(t), plan = preview(path), before = logical(path), original = join(dir, 'original.sqlite')
  assert.throws(() => removeSelected(plan, [selected(plan)], { beforeCommit() {
    renameSync(path, original)
    copyFileSync(original, path)
  } }), /file changed/)
  rmSync(path)
  renameSync(original, path)
  assert.deepEqual(logical(path), before)
})
for (const [name, sql] of Object.entries({ table: 'CREATE TABLE unrelated(secret TEXT)', trigger: 'CREATE TRIGGER trap AFTER DELETE ON checkpoints BEGIN DELETE FROM writes; END', index: 'CREATE INDEX extra ON checkpoints(thread_id)' })) {
  test(`unsupported ${name} refused before mutation`, t => {
    const { path } = fixture(t)
    edit(path, db => db.exec(sql))
    const before = readFileSync(path)
    assert.throws(() => preview(path), /Unsupported history layout/)
    assert.deepEqual(readFileSync(path), before)
  })
}
test('symlink and hard-linked stores are refused', t => {
  const { path, dir } = fixture(t)
  if (process.platform !== 'win32') { const link = join(dir, 'link.sqlite'); symlinkSync(path, link); assert.throws(() => preview(link), /without symbolic/) }
  const hard = join(dir, 'hard.sqlite'); linkSync(path, hard)
  assert.throws(() => preview(path), /without symbolic/)
})
test('missing stores are never created', t => {
  const { dir } = fixture(t)
  assert.throws(() => preview(join(dir, 'missing.sqlite')), /Store not found/)
  assert.deepEqual(readdirSync(dir), ['history.sqlite'])
})
test('writer lock is actionable; WAL preview succeeds and removal fails without deleting', t => {
  const { path } = fixture(t)
  const db = new DatabaseSync(path)
  t.after(() => db.close())
  db.exec('PRAGMA journal_mode=WAL; BEGIN IMMEDIATE')
  const plan = preview(path)
  assert.throws(() => removeSelected(plan, [selected(plan)]), /locked/)
  db.exec('ROLLBACK')
  assert.equal(summary(preview(path)).length, 2)
})
test('oversized values refused without mutation', t => {
  const { path } = fixture(t)
  edit(path, db => db.prepare('UPDATE checkpoints SET checkpoint=zeroblob(?) WHERE checkpoint_id=?').run(LIMITS.value + 1, 'old'))
  const before = statSync(path).size
  assert.throws(() => preview(path), /safe scan limit/)
  assert.equal(statSync(path).size, before)
})
test('oversized file is refused before SQLite opens it', t => {
  const { path } = fixture(t)
  truncateSync(path, LIMITS.file + 1)
  assert.throws(() => preview(path), /256 MiB/)
})
test('total payload bound is enforced across otherwise small values', t => {
  const { path } = fixture(t)
  edit(path, db => {
    const query = db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, NULL, ?, zeroblob(?), NULL)')
    db.exec('BEGIN')
    for (let i = 0; i < 10; i++) query.run('payload-thread', '', String(i), 'bytes', 7 * 1024 ** 2)
    db.exec('COMMIT')
  })
  assert.throws(() => preview(path), /safe scan limit/)
})
test('thread and row limits refuse a store without mutation', t => {
  const { path, dir } = fixture(t)
  edit(path, db => {
    const query = db.prepare('INSERT INTO checkpoints VALUES (?, ?, ?, NULL, NULL, NULL, NULL)')
    db.exec('BEGIN')
    for (let i = 0; i < LIMITS.threads; i++) query.run(`bounded-${i}`, '', String(i))
    db.exec('COMMIT')
  })
  assert.throws(() => preview(path), /1,000-thread/)
  const large = join(dir, 'rows.sqlite')
  edit(large, db => {
    db.exec(Object.values(SCHEMA).join(';'))
    db.exec(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x < ${LIMITS.rows}) INSERT INTO checkpoints SELECT 'same', '', CAST(x AS TEXT), NULL, NULL, NULL, NULL FROM n`)
  })
  assert.throws(() => preview(large), /100,000-row/)
})
test('private recovery folder required before mutation', t => {
  const { path, dir } = fixture(t), plan = preview(path), before = logical(path)
  symlinkSync(dir, join(dir, '.hh-traces-operations'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => removeSelected(plan, [selected(plan)]), /recovery folder/)
  assert.deepEqual(logical(path), before)
})
test('v1/v2 case boundaries, bounded base64 receipts and inert MessagePack', () => {
  const found = candidates(Buffer.from('payment-required X-PAYMENT PAYMENT-SIGNATURE payment-response X-PAYMENT-RESPONSE x402Version'))
  assert.equal(found['x402-authorization-marker'], 2)
  assert.equal(found['x402-settlement-marker'], 2)
  assert.equal(candidates(Buffer.from('not-X-PAYMENT-and-more'))['x402-authorization-marker'], undefined)
  const token = Buffer.from('{"transaction":"invented","network":"test","payer":"invented"}').toString('base64')
  assert.equal(candidates(Buffer.from(token))['base64-settlement-fields-candidate'], 1)
  const text = Buffer.from('X-PAYMENT')
  assert.ok(candidates(Buffer.concat([Buffer.from([0xa0 + text.length]), text]))['x402-authorization-marker'])
  assert.deepEqual(msgpackTexts(Buffer.from([0xdb, 0xff, 0xff, 0xff, 0xff])), [])
  assert.deepEqual(msgpackTexts(Buffer.alloc(0)), [])
  assert.equal(candidates(Buffer.from("__reduce__ os.system('DO-NOT-EXECUTE')"))['x402-authorization-marker'], undefined)
})
test('schema normalization accepts IF NOT EXISTS and whitespace, preserves quoted defaults', t => {
  const { dir } = fixture(t), path = join(dir, 'normalized.sqlite')
  edit(path, db => db.exec(Object.values(SCHEMA).map(sql => sql.replace('CREATE TABLE', 'CREATE TABLE IF NOT EXISTS')).join(';')))
  assert.equal(summary(preview(path)).length, 0)
  const unsupported = join(dir, 'unsupported.sqlite')
  edit(unsupported, db => db.exec(Object.values(SCHEMA).map(sql => sql.replace("DEFAULT ''", "DEFAULT ' '")).join(';')))
  assert.throws(() => preview(unsupported), /Unsupported/)
})
