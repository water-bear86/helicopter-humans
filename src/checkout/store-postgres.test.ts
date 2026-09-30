// Runs the service contract and the uniqueness rules against a real PostgreSQL server.
// Needs CHECKOUT_PG_TEST_URL pointing at a disposable database, e.g. a local container:
//   docker run -d --name hh-pg -e POSTGRES_PASSWORD=hhtest -e POSTGRES_DB=hh_test -p 127.0.0.1:55432:5432 postgres:17-alpine
//   CHECKOUT_PG_TEST_URL=postgres://postgres:hhtest@127.0.0.1:55432/hh_test npm run test:pg
// Each run creates and drops its own schema. Skipped (and reported as skipped) when the URL is unset.
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashRecoveryCode } from './credential'
import { checkConnectionString, PostgresOrderStore } from './store-postgres'
import { StoreConflictError, StoreUnavailableError } from './store'
import { harness, paidOrder, serviceContract } from './test-support'

const URL_ = process.env.CHECKOUT_PG_TEST_URL
const MIGRATION = readFileSync(new URL('../../db/migrations/0001_checkout_orders.sql', import.meta.url), 'utf8')
const schema = `checkout_test_${randomUUID().replaceAll('-', '')}`
const pools: pg.Pool[] = []

function pool(max = 4) {
  const p = new pg.Pool({ connectionString: URL_, max, idleTimeoutMillis: 200, options: `-c search_path=${schema}` })
  pools.push(p)
  return p
}

describe.skipIf(!URL_)('PostgreSQL order store', () => {
  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: URL_ })
    await admin.connect()
    await admin.query(`CREATE SCHEMA ${schema}`)
    await admin.query(`SET search_path TO ${schema}`)
    await admin.query(`BEGIN; ${MIGRATION}; COMMIT;`)
    await admin.end()
  })
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()))
    const admin = new pg.Client({ connectionString: URL_ })
    await admin.connect()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  })

  // Every scenario gets a separate pool, so concurrent calls really use separate connections.
  serviceContract('postgres store', () => new PostgresOrderStore({ pool: pool() }))

  it('refuses to apply the migration twice', async () => {
    const c = await pool(1).connect()
    try {
      await expect(c.query(`BEGIN; ${MIGRATION}; COMMIT;`)).rejects.toThrow()
      await c.query('ROLLBACK')
    } finally {
      c.release()
    }
  })

  it('enforces one receipt per order and per invoice, one invoice binding and one owner per txid in the schema itself', async () => {
    const store = new PostgresOrderStore({ pool: pool() })
    const h = harness(store)
    const a = await paidOrder(h)
    const b = await paidOrder(h)
    const db = pool(2)
    const orderA = (await store.findByCredentialHash(hashRecoveryCode(a.code)))!.order.id
    const orderB = (await store.findByCredentialHash(hashRecoveryCode(b.code)))!.order.id
    const receipt = (id: string, order: string, invoice: string) =>
      db.query(
        `INSERT INTO checkout_receipts (id, order_id, provider_invoice_id, offer_id, offer_version, fiat_amount_cents, price_zatoshis, received_zatoshis, created_at)
         VALUES ($1,$2,$3,'founding-agent-pass','v',900,100,100,now())`,
        [id, order, invoice],
      )
    await receipt(randomUUID(), orderA, a.invoiceId)
    await expect(receipt(randomUUID(), orderA, b.invoiceId)).rejects.toMatchObject({ code: '23505' })
    await expect(receipt(randomUUID(), orderB, a.invoiceId)).rejects.toMatchObject({ code: '23505' })
    await expect(
      db.query(`INSERT INTO checkout_invoices SELECT * FROM checkout_invoices WHERE provider_invoice_id = $1`, [a.invoiceId]),
    ).rejects.toMatchObject({ code: '23505' })
    const txid = 'ab'.repeat(32)
    await db.query(`INSERT INTO checkout_payment_txids VALUES ($1,$2,$3,now())`, [txid, orderA, a.invoiceId])
    await expect(db.query(`INSERT INTO checkout_payment_txids VALUES ($1,$2,$3,now())`, [txid, orderB, b.invoiceId])).rejects.toMatchObject({ code: '23505' })
    await expect(db.query(`UPDATE checkout_orders SET state = 'creating_invoice' WHERE id = $1`, [orderA])).rejects.toMatchObject({ code: '23514' })
    await expect(db.query(`UPDATE checkout_orders SET claim_token = gen_random_uuid() WHERE id = $1`, [orderA])).rejects.toMatchObject({ code: '23514' })
  })

  it('races two orders for the same txid across connections: exactly one owns it', async () => {
    const store = new PostgresOrderStore({ pool: pool() })
    const h = harness(store)
    const a = await paidOrder(h)
    const b = await paidOrder(h)
    const txid = 'cd'.repeat(32)
    for (const x of [a, b]) h.provider.reportTxid(x.invoiceId, txid, h.provider.invoices.get(x.invoiceId)!.price_zatoshis)
    const [va, vb] = await Promise.all([h.service.refresh(a.code), h.other.refresh(b.code)])
    const states = [va.state, vb.state].sort()
    expect(states).toEqual(['fulfilled', 'quarantined'])
    expect([va.receipt, vb.receipt].filter(Boolean)).toHaveLength(1)
  })

  it('maps constraint violations to conflicts and an unreachable server to unavailability', async () => {
    const store = new PostgresOrderStore({ pool: pool() })
    const h = harness(store)
    const { code } = await paidOrder(h)
    const order = (await store.findByCredentialHash(hashRecoveryCode(code)))!
    await expect(store.insertOrder({ ...order.order })).rejects.toBeInstanceOf(StoreConflictError)
    const dead = new PostgresOrderStore({ connectionString: 'postgres://nobody:x@127.0.0.1:1/none' })
    await expect(dead.findByCredentialHash('0'.repeat(64))).rejects.toBeInstanceOf(StoreUnavailableError)
    await expect(dead.update(order.order.id, () => ({ result: 1 }))).rejects.toBeInstanceOf(StoreUnavailableError)
    await dead.close()
  })
})

describe('PostgreSQL connection string policy', () => {
  it('requires TLS for any non-loopback host', () => {
    expect(() => checkConnectionString('postgres://u:p@db.example.com/app')).toThrow(/sslmode/)
    expect(() => checkConnectionString('postgres://u:p@db.example.com/app?sslmode=disable')).toThrow(/sslmode/)
    expect(() => checkConnectionString('postgres://u:p@db.example.com/app?sslmode=verify-full')).not.toThrow()
    expect(() => checkConnectionString('postgres://u:p@127.0.0.1:5432/app')).not.toThrow()
    expect(() => checkConnectionString('mysql://u:p@127.0.0.1/app')).toThrow()
    expect(() => checkConnectionString('not a url')).toThrow()
  })
})
