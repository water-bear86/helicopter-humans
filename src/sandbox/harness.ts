// Operator-run CipherPay testnet check through the accepted order service and state machine. Testnet
// only: the provider client is pinned to the testnet origin and `utest1` addresses, and the database
// must be a sandbox database that cannot hold mainnet invoices. Nothing here can create a mainnet
// invoice. One attempt per order file; a second `create` is refused until the operator removes it.
//
// The recovery code is written to a 0600 file and never printed. Payment details printed to the
// operator's terminal are testnet values with no monetary worth.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { looksLikeUnifiedAddress } from '../checkout/address.js'
import { CIPHERPAY_TESTNET_ORIGIN, createCipherPayClient, type InvoiceProvider } from '../checkout/cipherpay.js'
import { hashRecoveryCode, isRecoveryCode } from '../checkout/credential.js'
import type { Offer } from '../checkout/offer.js'
import { createCheckoutService, type OrderView } from '../checkout/service.js'
import type { OrderSnapshot, OrderStore } from '../checkout/store.js'
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

export class SandboxRefusal extends Error {}

// The order file is the operator's own, but its labels are only a first filter: the loaded order is
// checked against the sandbox identity as well (checkSandboxOrder) before any provider call.
export function readOrderFile(file: string): string {
  let saved: unknown
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new SandboxRefusal('order file is missing or not JSON')
  }
  const s = (typeof saved === 'object' && saved !== null ? saved : {}) as Record<string, unknown>
  if (typeof s.recoveryCode !== 'string' || !isRecoveryCode(s.recoveryCode)) throw new SandboxRefusal('order file has no valid recovery code')
  if (s.network !== 'testnet') throw new SandboxRefusal('order file is not labelled testnet')
  if (s.offerVersion !== SANDBOX_OFFER.version) throw new SandboxRefusal('order file is not for the sandbox offer version')
  return s.recoveryCode
}

// Refuses anything that is not a sandbox testnet order: another offer (such as a mainnet preorder),
// another offer version, or any invoice whose address is not a testnet address. Runs before the
// provider is contacted and before the store can change.
export function checkSandboxOrder(s: OrderSnapshot): void {
  if (s.order.offerId !== SANDBOX_OFFER.id || s.order.offerVersion !== SANDBOX_OFFER.version) throw new SandboxRefusal('order is not a sandbox testnet order')
  if (s.receipt && (s.receipt.offerId !== SANDBOX_OFFER.id || s.receipt.offerVersion !== SANDBOX_OFFER.version)) throw new SandboxRefusal('order receipt is not for the sandbox offer')
  if (!s.invoices.every((i) => looksLikeUnifiedAddress(i.paymentAddress, 'testnet'))) throw new SandboxRefusal('order has a non-testnet invoice address')
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
  const code = readOrderFile(deps.orderFile)
  const snapshot = await deps.store.findByCredentialHash(hashRecoveryCode(code))
  if (!snapshot) throw new SandboxRefusal('order not found in the sandbox database')
  checkSandboxOrder(snapshot)
  return evidence(await service(deps).refresh(code))
}

// An offline structural and privacy-policy check of the operator's own `getrawtransaction <txid> 1`
// output (zcashd verbose schema, https://zcash.github.io/rpc/getrawtransaction.html). It reads a
// public transaction document, never a key.
//
// Policy: a v5 (NU5) transaction whose value moves only inside the Orchard pool. No transparent
// inputs or outputs, no Sprout, no Sapling spends or outputs and a zero Sapling balance, Orchard
// spends and outputs both enabled, and an Orchard value balance that is exactly the (positive) fee.
// Anything that moves value between pools reveals the amount crossing on chain, so it fails. Missing
// or malformed fields fail. A transaction version this check does not know (v6 and later, for
// example under a future network upgrade) is reported unverified, never passed.
//
// A pass is not proof that the transaction is in a block, that the operator's wallet made it, that it
// paid a particular invoice, or that it is confirmed. Those need the provider's invoice record and
// the operator's own wallet evidence (docs/SANDBOX_TEST.md).
export type ShieldedCheck =
  | { fullyShielded: true; verdict: 'orchard_only'; orchardActions: number; feeZatoshis: number }
  | { fullyShielded: false; verdict: 'fail' | 'unverified'; reasons: string[] }

const HEX32 = /^[0-9a-f]{64}$/
const HEX = /^(?:[0-9a-f]{2})+$/
const V5_GROUP_ID = '26a7270a'
const ACTION_HEX32 = ['cv', 'nullifier', 'rk', 'cmx', 'ephemeralKey'] as const
const ACTION_HEX = ['encCiphertext', 'outCiphertext', 'spendAuthSig'] as const

export function checkShieldedTransaction(tx: unknown): ShieldedCheck {
  const fail = (...reasons: string[]): ShieldedCheck => ({ fullyShielded: false, verdict: 'fail', reasons })
  if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) return fail('not a transaction object')
  const t = tx as Record<string, unknown>
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
  const isZat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

  if (typeof t.version !== 'number' || !Number.isInteger(t.version)) return fail('version missing')
  if (t.version > 5) return { fullyShielded: false, verdict: 'unverified', reasons: [`transaction version ${t.version} is not supported by this check`] }
  if (t.version < 5) return fail('not a v5 transaction (no Orchard)')

  const reasons: string[] = []
  if (typeof t.txid !== 'string' || !HEX32.test(t.txid)) reasons.push('missing txid')
  if (t.overwintered !== true || t.versiongroupid !== V5_GROUP_ID) reasons.push('not a v5 (NU5) transaction encoding')

  const empty = (field: string, what: string) => {
    const v = t[field]
    if (!Array.isArray(v)) reasons.push(`${field} missing`)
    else if (v.length) reasons.push(what)
  }
  empty('vin', 'has transparent inputs')
  empty('vout', 'has transparent outputs')
  empty('vjoinsplit', 'has Sprout joinsplits')
  empty('vShieldedSpend', 'has Sapling spends (value crossing from Sapling)')
  empty('vShieldedOutput', 'has Sapling outputs (value crossing into Sapling)')
  if (t.valueBalanceZat !== undefined && !isZat(t.valueBalanceZat)) reasons.push('Sapling valueBalanceZat malformed')
  else if ((t.valueBalanceZat ?? 0) !== 0) reasons.push('nonzero Sapling value balance')

  const orchard = t.orchard
  if (!isObject(orchard)) return fail(...reasons, 'no Orchard bundle')
  const actions = orchard.actions
  if (!Array.isArray(actions) || actions.length === 0) reasons.push('no Orchard actions')
  else if (!actions.every((a) => isObject(a) && ACTION_HEX32.every((k) => typeof a[k] === 'string' && HEX32.test(a[k] as string)) && ACTION_HEX.every((k) => typeof a[k] === 'string' && HEX.test(a[k] as string)))) {
    reasons.push('Orchard action fields malformed')
  }
  const flags = orchard.flags
  if (!isObject(flags) || typeof flags.enableSpends !== 'boolean' || typeof flags.enableOutputs !== 'boolean') reasons.push('Orchard flags missing')
  else {
    if (!flags.enableSpends) reasons.push('Orchard spends disabled (value did not come from Orchard)')
    if (!flags.enableOutputs) reasons.push('Orchard outputs disabled (value did not go to Orchard)')
  }
  // With no transparent, Sprout or Sapling value, the Orchard balance is the whole fee.
  const fee = orchard.valueBalanceZat
  if (!isZat(fee)) reasons.push('Orchard valueBalanceZat missing')
  else if (fee <= 0) reasons.push('Orchard value balance is not a positive fee')
  else if (orchard.valueBalance !== undefined && (typeof orchard.valueBalance !== 'number' || Math.round(orchard.valueBalance * 1e8) !== fee)) reasons.push('Orchard valueBalance disagrees with valueBalanceZat')

  if (reasons.length) return fail(...reasons)
  return { fullyShielded: true, verdict: 'orchard_only', orchardActions: (actions as unknown[]).length, feeZatoshis: fee as number }
}
