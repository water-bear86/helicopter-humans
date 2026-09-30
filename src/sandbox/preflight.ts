// Preflight for the CipherPay testnet sandbox check. Read-only and bounded: it checks configuration
// by name and shape first, and only when all of that passes, one read-only database probe, then the
// caller's own database-side check if it supplied one (refresh checks the loaded order's identity),
// and only then one unauthenticated provider health GET. It never prints a configuration value, and
// it fails closed: anything missing or unverified is not ready.
//
// The sandbox harness is testnet only. There is no mainnet mode and no network fallback here; the
// mainnet payment test is a separate, explicitly authorised step (docs/SANDBOX_TEST.md).
import pg from 'pg'
import { BodyTooLarge, CIPHERPAY_TESTNET_ORIGIN, readBounded } from '../checkout/cipherpay.js'
import { isHosted, type Env } from '../checkout/readiness.js'

export type CheckStatus = 'pass' | 'fail' | 'missing' | 'skipped'

export interface Check {
  id: string
  status: CheckStatus
  // Never contains a configuration value.
  detail: string
}

export interface PreflightReport {
  ready: boolean
  network: 'testnet'
  providerOrigin: string
  checks: Check[]
  // Facts only a person can confirm, in the provider dashboard or their own wallet. Not checked here.
  operatorConfirmations: string[]
}

export interface DatabaseProbe {
  checkoutTables: boolean
  testnetOnlyAddresses: boolean
}

export interface PreflightDeps {
  fetch?: typeof fetch
  probeDatabase?: (connectionString: string) => Promise<DatabaseProbe>
  offline?: boolean
  // Runs after the schema check passes and before the provider is contacted; a non-pass skips the
  // provider. Must not contact the provider itself.
  beforeProvider?: () => Promise<Check>
}

// What a command may add to the preflight. Anything supplied as the command's preflight must pass it on.
export type PreflightStages = Pick<PreflightDeps, 'beforeProvider'>

export const SANDBOX_ENV = Object.freeze({
  network: 'SANDBOX_NETWORK',
  apiKey: 'SANDBOX_CIPHERPAY_API_KEY',
  databaseUrl: 'SANDBOX_DATABASE_URL',
  disposable: 'SANDBOX_DATABASE_IS_DISPOSABLE',
})

const TABLES = ['checkout_orders', 'checkout_invoices', 'checkout_payment_txids', 'checkout_receipts', 'checkout_refund_requests']

export const OPERATOR_CONFIRMATIONS = Object.freeze([
  'The testnet merchant account was created on testnet.cipherpay.app, and its API key came from that dashboard (a key only works on the server that issued it).',
  'Only a testnet viewing key (uviewtest/uivktest) was registered, directly with CipherPay; no seed or spending key left the operator wallet.',
  "The dashboard's fee rate and billing method for this account are recorded on the issue as non-secret facts. A fee recipient in the payment URI makes the harness reject the quote.",
  'A testnet wallet able to make an Orchard-shielded spend is funded with testnet ZEC (no real value).',
])

export function checkConnectionShape(value: string): string | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'not a URL'
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return 'not a postgres:// URL'
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  const sslmode = url.searchParams.get('sslmode')
  if (!loopback && sslmode !== 'require' && sslmode !== 'verify-full') return 'remote database without sslmode=require or verify-full'
  return undefined
}

// The sandbox constraint exactly as PostgreSQL reports it after db/sandbox/0001_testnet_only.sql.
// Compared by definition, not by name: a renamed mainnet constraint or a permissive check is refused.
export const TESTNET_ADDRESS_CHECK =
  "CHECK (((payment_address ~ '^utest1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]+$'::text) AND ((length(payment_address) >= 66) AND (length(payment_address) <= 1006))))"

// Read-only catalog queries inside a READ ONLY transaction: no insert, no migration, no fixture.
export async function probeDatabase(connectionString: string): Promise<DatabaseProbe> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 6000, application_name: 'helicopter-humans-sandbox-preflight' })
  await client.connect()
  try {
    await client.query('BEGIN READ ONLY')
    // All five tables must resolve (through the connection's search_path, as the store resolves them)
    // into one schema.
    const tables = await client.query<{ found: string; schemas: string }>(
      'SELECT count(c.oid)::text AS found, count(DISTINCT c.relnamespace)::text AS schemas FROM unnest($1::text[]) AS t(name) LEFT JOIN pg_class c ON c.oid = to_regclass(t.name)',
      [TABLES],
    )
    // Every CHECK constraint on the resolved checkout_invoices table that involves payment_address.
    const checks = await client.query<{ convalidated: boolean; definition: string; only_address: boolean }>(
      `SELECT con.convalidated, pg_get_constraintdef(con.oid) AS definition,
              con.conkey = ARRAY[att.attnum] AS only_address
         FROM pg_constraint con
         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attname = 'payment_address' AND NOT att.attisdropped
        WHERE con.conrelid = to_regclass('checkout_invoices') AND con.contype = 'c' AND att.attnum = ANY (con.conkey)`,
    )
    await client.query('ROLLBACK')
    const row = tables.rows[0]
    const only = checks.rows.length === 1 ? checks.rows[0] : undefined
    return {
      checkoutTables: Number(row?.found) === TABLES.length && Number(row?.schemas) === 1,
      testnetOnlyAddresses: only !== undefined && only.convalidated && only.only_address && only.definition === TESTNET_ADDRESS_CHECK,
    }
  } finally {
    await client.end().catch(() => undefined)
  }
}

const HEALTH_MAX_BYTES = 4096

async function providerHealth(doFetch: typeof fetch): Promise<Check> {
  try {
    // One deadline covers the connection and the body; the body is read up to HEALTH_MAX_BYTES only.
    const res = await doFetch(`${CIPHERPAY_TESTNET_ORIGIN}/api/health`, { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { accept: 'application/json' } })
    let text: string
    try {
      text = await readBounded(res, HEALTH_MAX_BYTES)
    } catch (error) {
      if (!(error instanceof BodyTooLarge)) throw error
      return { id: 'provider_testnet_health', status: 'fail', detail: `testnet API health response exceeded ${HEALTH_MAX_BYTES} bytes` }
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
    const ok = res.status === 200 && typeof body === 'object' && body !== null && (body as Record<string, unknown>).status === 'ok'
    return { id: 'provider_testnet_health', status: ok ? 'pass' : 'fail', detail: ok ? 'testnet API health ok' : `testnet API health answered HTTP ${res.status}` }
  } catch {
    return { id: 'provider_testnet_health', status: 'fail', detail: 'testnet API unreachable within 5 s' }
  }
}

export async function runPreflight(env: Env, deps: PreflightDeps = {}): Promise<PreflightReport> {
  const checks: Check[] = []
  const add = (id: string, status: CheckStatus, detail: string) => checks.push({ id, status, detail })
  const present = (name: string) => typeof env[name] === 'string' && env[name] !== ''

  add('runtime_local', isHosted(env) ? 'fail' : 'pass', isHosted(env) ? 'refused: hosted runtime (VERCEL, VERCEL_ENV or NODE_ENV=production set)' : 'local operator machine')

  if (!present(SANDBOX_ENV.network)) add('network_testnet', 'missing', `${SANDBOX_ENV.network} is not set; it must be exactly "testnet"`)
  else add('network_testnet', env[SANDBOX_ENV.network] === 'testnet' ? 'pass' : 'fail', env[SANDBOX_ENV.network] === 'testnet' ? 'testnet' : `${SANDBOX_ENV.network} must be exactly "testnet"; no other network is supported`)

  const key = env[SANDBOX_ENV.apiKey]
  if (!present(SANDBOX_ENV.apiKey)) add('api_key', 'missing', `${SANDBOX_ENV.apiKey} is not set`)
  else if (!/^cpay_sk_[\x21-\x7e]{8,256}$/.test(key!)) add('api_key', 'fail', `${SANDBOX_ENV.apiKey} is set but is not shaped like a CipherPay secret key (cpay_sk_...)`)
  else if (present('CIPHERPAY_API_KEY') && env.CIPHERPAY_API_KEY === key) add('api_key', 'fail', `${SANDBOX_ENV.apiKey} equals CIPHERPAY_API_KEY; use the separate testnet merchant key`)
  else add('api_key', 'pass', `${SANDBOX_ENV.apiKey} is set (value not shown)`)

  const dbUrl = env[SANDBOX_ENV.databaseUrl]
  if (!present(SANDBOX_ENV.databaseUrl)) add('database_url', 'missing', `${SANDBOX_ENV.databaseUrl} is not set`)
  else if (present('CHECKOUT_DATABASE_URL') && env.CHECKOUT_DATABASE_URL === dbUrl) add('database_url', 'fail', `${SANDBOX_ENV.databaseUrl} equals CHECKOUT_DATABASE_URL; the sandbox needs its own disposable database`)
  else {
    const problem = checkConnectionShape(dbUrl!)
    add('database_url', problem ? 'fail' : 'pass', problem ? `${SANDBOX_ENV.databaseUrl}: ${problem}` : `${SANDBOX_ENV.databaseUrl} is set (value not shown)`)
  }

  if (!present(SANDBOX_ENV.disposable)) add('database_disposable', 'missing', `${SANDBOX_ENV.disposable} is not set; set it to "yes" only for a disposable sandbox database`)
  else add('database_disposable', env[SANDBOX_ENV.disposable] === 'yes' ? 'pass' : 'fail', env[SANDBOX_ENV.disposable] === 'yes' ? 'operator confirmed disposable' : `${SANDBOX_ENV.disposable} must be "yes"`)

  // Nothing external is contacted unless every local check passed: a refused configuration reaches
  // neither the database nor the provider. The database is checked before the provider is contacted.
  const localOk = checks.every((c) => c.status === 'pass')
  if (deps.offline) {
    add('database_schema', 'skipped', 'offline run: database not contacted')
    add('provider_testnet_health', 'skipped', 'offline run: provider not contacted')
  } else if (!localOk) {
    add('database_schema', 'skipped', 'a local check failed: database not contacted')
    add('provider_testnet_health', 'skipped', 'a local check failed: provider not contacted')
  } else {
    let schemaOk = false
    try {
      const probe = await (deps.probeDatabase ?? probeDatabase)(dbUrl!)
      if (!probe.checkoutTables) add('database_schema', 'fail', 'checkout tables missing or split across schemas: apply db/migrations/0001_checkout_orders.sql')
      else if (!probe.testnetOnlyAddresses) add('database_schema', 'fail', 'not a sandbox database: the only payment_address check must be the validated db/sandbox/0001_testnet_only.sql definition')
      else {
        schemaOk = true
        add('database_schema', 'pass', 'checkout schema present, invoice addresses restricted to testnet')
      }
    } catch {
      add('database_schema', 'fail', 'database unreachable or query refused within 5 s')
    }
    const before = schemaOk && deps.beforeProvider ? await deps.beforeProvider() : undefined
    if (before) checks.push(before)
    if (!schemaOk) add('provider_testnet_health', 'skipped', 'database check failed: provider not contacted')
    else if (before && before.status !== 'pass') add('provider_testnet_health', 'skipped', `${before.id} did not pass: provider not contacted`)
    else checks.push(await providerHealth(deps.fetch ?? fetch))
  }

  return {
    ready: checks.every((c) => c.status === 'pass'),
    network: 'testnet',
    providerOrigin: CIPHERPAY_TESTNET_ORIGIN,
    checks,
    operatorConfirmations: [...OPERATOR_CONFIRMATIONS],
  }
}
