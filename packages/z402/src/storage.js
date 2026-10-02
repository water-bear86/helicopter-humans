import { DatabaseSync } from 'node:sqlite'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { constants, openSync, closeSync, fchmodSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assert, canonical, hash, zatoshis } from './protocol.js'

// A local SQLite runtime owns all reservations. It is deliberately not a shared hosted ledger.
export class PrivateStore {
  constructor(path, key, { budgetZat } = {}) {
    assert(Buffer.isBuffer(key) && key.length === 32, 'invalid_storage_key')
    const directory = dirname(resolve(path))
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    assert(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink() && (lstatSync(directory).mode & 0o077) === 0, 'unsafe_storage_directory')
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    fchmodSync(fd, 0o600); closeSync(fd)
    this.key = key
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, sealed TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims (id TEXT PRIMARY KEY, purchase TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS locks (id TEXT PRIMARY KEY, pid INTEGER NOT NULL, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, maximum INTEGER NOT NULL, charged INTEGER, state TEXT NOT NULL CHECK(state IN ('reserved','charged','released')));
      CREATE TABLE IF NOT EXISTS budget (id INTEGER PRIMARY KEY CHECK(id=1), maximum INTEGER NOT NULL);`)
    if (budgetZat !== undefined) {
      const maximum = Number(zatoshis(budgetZat))
      this.db.prepare('INSERT OR IGNORE INTO budget VALUES (1, ?)').run(maximum)
      assert(this.db.prepare('SELECT maximum FROM budget WHERE id=1').get().maximum === maximum, 'budget_configuration_changed')
    }
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = action(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  get(id) {
    const record = this.db.prepare('SELECT sealed FROM records WHERE id=?').get(id)
    if (!record) return undefined
    const { iv, tag, ciphertext } = JSON.parse(record.sealed)
    const cipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'))
    cipher.setAAD(Buffer.from(id)); cipher.setAuthTag(Buffer.from(tag, 'base64'))
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64')), cipher.final()]).toString('utf8'))
  }
  put(id, value) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(id))
    const ciphertext = Buffer.concat([cipher.update(canonical(value)), cipher.final()])
    const sealed = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') })
    this.db.prepare('INSERT INTO records VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed').run(id, sealed)
  }
  reserve(id, maximumZat) {
    return this.transaction(() => {
      const maximum = Number(zatoshis(maximumZat))
      const previous = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id)
      if (previous) { assert(previous.maximum === maximum && previous.state !== 'released', 'reservation_mismatch'); return }
      const budget = this.db.prepare('SELECT maximum FROM budget WHERE id=1').get()
      assert(budget, 'budget_missing')
      const used = this.db.prepare("SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN maximum WHEN state='charged' THEN charged ELSE 0 END),0) AS total FROM reservations").get().total
      assert(used + maximum <= budget.maximum, 'budget_exhausted')
      this.db.prepare("INSERT INTO reservations VALUES (?, ?, NULL, 'reserved')").run(id, maximum)
    })
  }
  charge(id, chargedZat) {
    this.transaction(() => {
      const charged = Number(zatoshis(chargedZat))
      const row = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id)
      assert(row && row.state !== 'released' && charged <= row.maximum && (row.state !== 'charged' || row.charged === charged), 'invalid_charge')
      this.db.prepare("UPDATE reservations SET state='charged',charged=? WHERE id=?").run(charged, id)
    })
  }
  claim(network, txid, outputIndex, purchase) {
    const id = hash({ network, txid, outputIndex })
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO claims VALUES (?, ?)').run(id, purchase)
      return this.db.prepare('SELECT purchase FROM claims WHERE id=?').get(id).purchase === purchase
    })
  }
  async locked(id, action) {
    const token = randomBytes(24).toString('hex')
    this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM locks WHERE id=?').get(id)
      if (previous) {
        let alive = true
        try { process.kill(previous.pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
        assert(!alive, 'purchase_busy')
        this.db.prepare('DELETE FROM locks WHERE id=?').run(id)
      }
      this.db.prepare('INSERT INTO locks VALUES (?, ?, ?)').run(id, process.pid, token)
    })
    try { return await action() }
    finally { this.db.prepare('DELETE FROM locks WHERE id=? AND token=?').run(id, token) }
  }
  close() { this.db.close() }
}
