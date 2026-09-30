// Operator-run CipherPay testnet check through the accepted order service and state machine. Testnet
// only: the provider client is pinned to the testnet origin and `utest1` addresses, and the database
// must be a sandbox database that cannot hold mainnet invoices. Nothing here can create a mainnet
// invoice. One attempt per order file; a second `create` is refused until the operator removes it.
//
// The recovery code is written to a 0600 file and never printed. Payment details printed to the
// operator's terminal are testnet values with no monetary worth.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { CIPHERPAY_TESTNET_ORIGIN, createCipherPayClient, type InvoiceProvider } from '../checkout/cipherpay.js'
import type { Offer } from '../checkout/offer.js'
import { createCheckoutService, type OrderView } from '../checkout/service.js'
import type { OrderStore } from '../checkout/store.js'
import { PostgresOrderStore } from '../checkout/store-postgres.js'
import type { Env } from '../checkout/readiness.js'
import { SANDBOX_ENV } from './preflight.js'

// Testnet only, never shown to a buyer and never served by a route. Mirrors the proposed US$1.50 test.
export const SANDBOX_OFFER: Offer = Object.freeze({
  id: 'sandbox-testnet-check',
  version: 'sandbox-2026-09-30-1',
  approved: false,
  title: 'Sandbox testnet check (no value)',
  fiatAmountCents: 150,
  fiatCurrency: 'USD',
  priceLabel: 'US$1.50 in testnet ZEC (no value)',
  providerProductName: 'Helicopter Humans testnet check',
  summary: 'Testnet sandbox invoice for an operator check. Not a sale; testnet ZEC has no value.',
  refundTerms: 'Not applicable: testnet only.',
})

export interface HarnessDeps {
  store: OrderStore & { close?: () => Promise<void> }
  provider: InvoiceProvider
  orderFile: string
  now?: () => number
}

export function testnetDeps(env: Env, orderFile: string): HarnessDeps {
  const store = new PostgresOrderStore({ connectionString: env[SANDBOX_ENV.databaseUrl]! })
  const provider = createCipherPayClient({ origin: CIPHERPAY_TESTNET_ORIGIN, apiKey: env[SANDBOX_ENV.apiKey]!, network: 'testnet' })
  return { store, provider, orderFile }
}

function service(deps: HarnessDeps) {
  return createCheckoutService({ store: deps.store, provider: deps.provider, offer: SANDBOX_OFFER, network: 'testnet', now: deps.now })
}

function readCode(file: string): string {
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { recoveryCode?: unknown }
  if (typeof saved.recoveryCode !== 'string') throw new Error('order file has no recovery code')
  return saved.recoveryCode
}

// What the operator records on the issue. No recovery code, no key, no database URL.
export interface Evidence {
  network: 'testnet'
  providerOrigin: string
  offer: { id: string; version: string }
  state: OrderView['state']
  stateReason: string | null
  notice: OrderView['notice']
  payment: { amountZec: string; address: string; expiresAt: string; reference: string } | null
  received: OrderView['received']
  receipt: OrderView['receipt']
}

export function evidence(view: OrderView): Evidence {
  return {
    network: 'testnet',
    providerOrigin: CIPHERPAY_TESTNET_ORIGIN,
    offer: { id: view.offer.id, version: view.offer.version },
    state: view.state,
    stateReason: view.stateReason,
    notice: view.notice,
    payment: view.payment && { amountZec: view.payment.amountZec, address: view.payment.address, expiresAt: view.payment.expiresAt, reference: view.payment.reference },
    received: view.received,
    receipt: view.receipt,
  }
}

export async function createTestnetOrder(deps: HarnessDeps): Promise<{ evidence: Evidence; uri: string | null }> {
  if (existsSync(deps.orderFile)) throw new Error(`an order file already exists (${deps.orderFile}); one attempt per file, refresh it or remove it deliberately`)
  const svc = service(deps)
  const { recoveryCode } = await svc.createOrder()
  mkdirSync(dirname(deps.orderFile), { recursive: true, mode: 0o700 })
  writeFileSync(deps.orderFile, JSON.stringify({ recoveryCode, network: 'testnet', offerVersion: SANDBOX_OFFER.version }), { mode: 0o600, flag: 'wx' })
  const view = await svc.ensureInvoice(recoveryCode)
  return { evidence: evidence(view), uri: view.payment?.uri ?? null }
}

export async function refreshTestnetOrder(deps: HarnessDeps): Promise<Evidence> {
  return evidence(await service(deps).refresh(readCode(deps.orderFile)))
}

// Checks the operator's own `getrawtransaction <txid> 1` output (zcashd/Zallet verbose JSON) for a
// fully shielded spend: no transparent inputs or outputs, no Sprout, and value only in Orchard or
// Sapling. It reads a public transaction document, never a key. CipherPay detects Orchard payments,
// so Orchard actions are required for this check to pass.
export type ShieldedCheck = { fullyShielded: true; orchardActions: number; saplingSpends: number; saplingOutputs: number } | { fullyShielded: false; reasons: string[] }

export function checkShieldedTransaction(tx: unknown): ShieldedCheck {
  if (typeof tx !== 'object' || tx === null) return { fullyShielded: false, reasons: ['not a transaction object'] }
  const t = tx as Record<string, unknown>
  const len = (v: unknown) => (Array.isArray(v) ? v.length : undefined)
  const reasons: string[] = []
  if (typeof t.txid !== 'string' || !/^[0-9a-f]{64}$/.test(t.txid)) reasons.push('missing txid')
  if (len(t.vin) !== 0) reasons.push(len(t.vin) === undefined ? 'vin missing' : 'has transparent inputs')
  if (len(t.vout) !== 0) reasons.push(len(t.vout) === undefined ? 'vout missing' : 'has transparent outputs')
  if ((len(t.vjoinsplit) ?? 0) > 0) reasons.push('has Sprout joinsplits')
  const orchard = t.orchard as Record<string, unknown> | undefined
  const orchardActions = len(orchard?.actions) ?? 0
  if (orchardActions === 0) reasons.push('no Orchard actions (CipherPay detects Orchard payments)')
  if (reasons.length) return { fullyShielded: false, reasons }
  return { fullyShielded: true, orchardActions, saplingSpends: len(t.vShieldedSpend) ?? 0, saplingOutputs: len(t.vShieldedOutput) ?? 0 }
}
