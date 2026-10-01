// SPDX-License-Identifier: MIT
import { DatabaseSync } from 'node:sqlite'
import { lstatSync, mkdirSync, openSync, writeFileSync, closeSync, fsyncSync, readFileSync, renameSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { candidates } from './markers.js'

// Schema contract from langgraph-checkpoint-sqlite 3.1.1 (MIT, LangChain Inc.).
export const SCHEMA = {
  checkpoints: `CREATE TABLE checkpoints (
    thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL, parent_checkpoint_id TEXT, type TEXT,
    checkpoint BLOB, metadata BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id))`,
  writes: `CREATE TABLE writes (
    thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL, task_id TEXT NOT NULL, idx INTEGER NOT NULL,
    channel TEXT NOT NULL, type TEXT, value BLOB,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx))`,
}
const columns = {
  checkpoints: ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'parent_checkpoint_id', 'type', 'checkpoint', 'metadata'],
  writes: ['thread_id', 'checkpoint_ns', 'checkpoint_id', 'task_id', 'idx', 'channel', 'type', 'value'],
}
export const LIMITS = { file: 256 * 1024 ** 2, value: 8 * 1024 ** 2, payload: 64 * 1024 ** 2, rows: 100_000, threads: 1000 }
export class Refusal extends Error {}
export const normalizeSql = sql => sql.trim().split(/('(?:[^']|'')*')/).map((part, i) => i % 2 ? part : part.replace(/\s+/g, '').toLowerCase()).join('').replace('createtableifnotexists', 'createtable')

function identity(path) {
  let info
  try { info = lstatSync(path) } catch { throw new Refusal('Store not found or unreadable. Choose an existing local history file; nothing was created.') }
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw new Refusal('Choose a regular history file without symbolic or hard links.')
  if (info.size > LIMITS.file) throw new Refusal('This history exceeds the 256 MiB limit. Use a smaller supported store.')
  return `${info.dev}:${info.ino}`
}
function sameIdentity(path, expected) {
  if (identity(path) !== expected) throw new Refusal('The selected file changed. Start a fresh preview before removing anything.')
}
function database(path, writable, action) {
  const expected = identity(path)
  let db
  try {
    db = new DatabaseSync(path, { readOnly: !writable, allowExtension: false, timeout: 0 })
    sameIdentity(path, expected)
    db.exec('PRAGMA trusted_schema=OFF')
    if (!writable) db.exec('PRAGMA query_only=ON')
    db.exec(writable ? 'BEGIN IMMEDIATE' : 'BEGIN')
    return action(db, expected)
  } catch (error) {
    if (error instanceof Refusal) throw error
    if (error.errcode === 5 || error.errcode === 6) throw new Refusal('This history is locked. Stop the agent and other apps using it, then retry the preview.')
    throw new Refusal('This history could not be read safely. Check file access and the supported LangGraph layout. No uncommitted removal was kept.')
  } finally {
    if (db) {
      try { if (db.isTransaction) db.exec('ROLLBACK') } finally { db.close() }
    }
  }
}
function validate(db) {
  const entries = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema').all()
  const seen = new Set()
  for (const row of entries) {
    if (row.type === 'table' && SCHEMA[row.name] && normalizeSql(row.sql) === normalizeSql(SCHEMA[row.name])) seen.add(row.name)
    else if (!(row.type === 'index' && row.sql === null && SCHEMA[row.tbl_name] && row.name === `sqlite_autoindex_${row.tbl_name}_1`)) {
      throw new Refusal('Unsupported history layout. Only the LangGraph SqliteSaver 3.1.1 two-table layout is supported; no changes were made.')
    }
  }
  if (seen.size !== 2) throw new Refusal('Unsupported history layout. Choose a LangGraph SqliteSaver 3.1.1 history file.')
  const check = db.prepare('PRAGMA quick_check').all()
  if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Refusal('This history failed its integrity check. Repair it with your app before using cleanup.')
}
function bytes(value) {
  if (value === null) return ['null', Buffer.alloc(0)]
  if (typeof value === 'string') return ['text', Buffer.from(value)]
  if (typeof value === 'bigint') return ['integer', Buffer.from(String(value))]
  if (typeof value === 'number') { const b = Buffer.alloc(8); b.writeDoubleBE(value); return ['float', b] }
  return ['blob', Buffer.from(value)]
}
function inspect(db, salt) {
  validate(db)
  const digest = createHmac('sha256', salt)
  const threads = new Map()
  let rows = 0, payload = 0
  for (const table of Object.keys(SCHEMA)) {
    const count = db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
    rows += count
    if (rows > LIMITS.rows) throw new Refusal('This history exceeds the 100,000-row limit. No changes were made.')
    const sizes = columns[table].map(column => `coalesce(length(CAST(${column} AS BLOB)),0)`)
    const bounds = db.prepare(`SELECT coalesce(max(max(${sizes.join(',')})),0) AS largest, coalesce(sum(${sizes.join('+')}),0) AS total FROM ${table}`).get()
    if (bounds.largest > LIMITS.value || (payload += bounds.total) > LIMITS.payload) throw new Refusal('Saved content exceeds the safe scan limit (8 MiB per value, 64 MiB total). No changes were made.')
    digest.update(table)
    const order = table === 'checkpoints' ? 'thread_id, checkpoint_ns, checkpoint_id' : 'thread_id, checkpoint_ns, checkpoint_id, task_id, idx'
    const query = db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
    query.setReadBigInts(true)
    for (const row of query.iterate()) {
      if (typeof row.thread_id !== 'string') throw new Refusal('Unsupported thread identifiers. No changes were made.')
      if (!threads.has(row.thread_id)) threads.set(row.thread_id, { checkpoints: 0, writes: 0, matches: {} })
      if (threads.size > LIMITS.threads) throw new Refusal('This history exceeds the 1,000-thread limit. No changes were made.')
      const thread = threads.get(row.thread_id)
      thread[table]++
      for (const column of columns[table]) {
        const [type, data] = bytes(row[column])
        const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(data.length))
        digest.update(type).update(length).update(data)
        for (const [name, n] of Object.entries(candidates(data))) thread.matches[name] = (thread.matches[name] ?? 0) + n
      }
    }
  }
  const entries = [...threads].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const handles = new Map(entries.map(([id, thread], i) => [`thread-${String(i + 1).padStart(4, '0')}`, { id, ...thread }]))
  return { fingerprint: digest.digest('hex'), handles }
}
export function preview(store) {
  const path = resolve(store), salt = randomBytes(32)
  return database(path, false, (db, fileIdentity) => ({ path, salt, fileIdentity, ...inspect(db, salt) }))
}
export function summary(plan) {
  return [...plan.handles].map(([label, { checkpoints, writes, matches }]) => ({ label, checkpoints, writes, matches }))
}
function persist(path, record, exclusive = false) {
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`
  const fd = openSync(target, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(record, null, 2) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
  if (!exclusive) renameSync(target, path)
}
export function removeSelected(plan, labels, hooks = {}) {
  if (!labels.length || new Set(labels).size !== labels.length || labels.some(label => !plan.handles.has(label))) throw new Refusal('Select distinct threads from this preview before removing anything.')
  sameIdentity(plan.path, plan.fileIdentity)
  const directory = join(dirname(plan.path), '.hh-traces-operations')
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) { if (error.code !== 'EEXIST') throw new Refusal('Cannot save the recovery receipt beside this history. Check folder access; no removal was started.') }
  const info = lstatSync(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Refusal('The recovery folder must be private and must not be a link. No removal was started.')
  const receiptPath = join(directory, `${randomUUID()}.json`)
  const record = { format: 'hh-traces-operation-1', status: 'prepared', fileIdentity: plan.fileIdentity, salt: plan.salt.toString('hex'), before: plan.fingerprint, after: null, threads: labels.length }
  try { persist(receiptPath, record, true) } catch { throw new Refusal('Cannot save the recovery receipt. Check folder access; no removal was started.') }
  let committed = false
  try {
    database(plan.path, true, (db, fileIdentity) => {
      if (fileIdentity !== plan.fileIdentity || inspect(db, plan.salt).fingerprint !== plan.fingerprint) throw new Refusal('The history changed since the preview. Start again; no removal was kept.')
      for (const label of labels) {
        const id = plan.handles.get(label).id
        for (const table of Object.keys(SCHEMA)) {
          db.prepare(`DELETE FROM ${table} WHERE thread_id = ?`).run(id)
          if (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE thread_id = ?`).get(id).n !== 0) throw new Refusal('Removal verification failed. The operation was rolled back.')
        }
      }
      record.after = inspect(db, plan.salt).fingerprint
      persist(receiptPath, record)
      hooks.beforeCommit?.(db)
      sameIdentity(plan.path, plan.fileIdentity)
      db.exec('COMMIT')
      committed = true
    })
    record.status = 'completed'
    persist(receiptPath, record)
    return { threads: labels.length, receiptPath }
  } catch (error) {
    if (committed) throw new Refusal('Removal committed, but the receipt could not be finalized. Use --recover with the prepared receipt before retrying.')
    record.status = 'rolled-back'
    try { persist(receiptPath, record) } catch { /* Prepared receipt can still be checked read-only. */ }
    throw error
  }
}
export function recover(store, receiptPath) {
  const info = lstatSync(receiptPath)
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16_384) throw new Refusal('Choose a small, regular operation receipt created by this tool.')
  let record
  try { record = JSON.parse(readFileSync(receiptPath, 'utf8')) } catch { throw new Refusal('This operation receipt is unreadable.') }
  if (record.format !== 'hh-traces-operation-1' || !/^[a-f0-9]{64}$/.test(record.salt) || !/^[a-f0-9]{64}$/.test(record.before) || (record.after !== null && !/^[a-f0-9]{64}$/.test(record.after))) throw new Refusal('Unsupported operation receipt.')
  const path = resolve(store)
  return database(path, false, (db, fileIdentity) => {
    if (fileIdentity !== record.fileIdentity) throw new Refusal('This receipt belongs to a different file. Nothing was changed.')
    const current = inspect(db, Buffer.from(record.salt, 'hex')).fingerprint
    return current === record.after ? 'applied' : current === record.before ? 'not-applied' : 'changed-since-operation'
  })
}
