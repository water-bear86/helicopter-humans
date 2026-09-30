// Checkout preview page. Renders whatever /api/checkout/* says; holds no prices, addresses or terms
// of its own. On every hosted deployment those routes answer 503, so this page shows "closed".
// The recovery code lives only in this module's memory and the Authorization header: never in the
// URL, storage, cookies or console.
import './styles.css'
import type { OrderView } from './checkout/service'

interface Config {
  mode: 'fixture' | 'live'
  blockers: string[]
  offer: { id: string; version: string; approved: boolean; title: string; priceLabel: string; summary: string; refundTerms: string }
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing`)
  return el as T
}

const BLOCKER_TEXT: Record<string, string> = {
  offer_not_approved: 'The price, credit and refund terms are a draft awaiting approval.',
  merchant_fee_config_unverified: 'The merchant account, receiving wallet and fee terms are not verified.',
  durable_store_not_deployed: 'The order database is not deployed.',
  no_confirmed_payer: 'No wallet has been shown to pay one of these invoices with a fully shielded spend.',
  no_authorized_mainnet_e2e: 'No authorized real-money test has been run end to end.',
}

const STATE_LABEL: Record<OrderView['state'], string> = {
  new: 'Order created',
  creating_invoice: 'Creating invoice',
  quote_unverified: 'Checking invoice',
  awaiting_payment: 'Awaiting payment',
  payment_detected: 'Payment detected',
  fulfilled: 'Confirmed',
  expired: 'Quote expired',
  quote_rejected: 'Quote rejected',
  needs_resolution: 'Needs review',
  reconciliation_required: 'Needs review',
  quarantined: 'On hold',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
}

function stateMessage(v: OrderView): string {
  switch (v.state) {
    case 'new':
      return 'Nothing to pay yet. Get an invoice when you are ready.'
    case 'creating_invoice':
      return 'Creating your invoice. Refresh in a few seconds.'
    case 'quote_unverified':
      return 'The invoice has not been checked yet, so there is nothing to pay. Refresh to check it.'
    case 'awaiting_payment':
      return v.payment
        ? 'Send exactly this amount to this address before it expires, then refresh the status. Send it once.'
        : 'This quote has passed its expiry time. Do not pay it. Refresh the status.'
    case 'payment_detected':
      return 'Payment seen on the network, waiting for confirmation. Do not send it again.'
    case 'fulfilled':
      return 'Payment confirmed. Your preorder is recorded.'
    case 'expired':
      return 'This quote expired and nothing was received. Get a new quote if you still want the pass.'
    case 'quote_rejected':
      return 'The provider returned an invoice that failed our checks, so we never showed it. There is nothing to pay.'
    case 'needs_resolution':
      return 'We received ZEC for this order that we cannot accept automatically. Do not send more. Request a refund below, or wait for an operator to review it.'
    case 'reconciliation_required':
      return 'We could not confirm what the payment provider did. Do not pay anything for this order. An operator will review it.'
    case 'quarantined':
      return 'This payment is already linked to another order. Do not send more. An operator will review it.'
    case 'cancelled':
      return 'Order cancelled. Do not pay its invoice. If you already paid, request a refund below.'
    case 'refunded':
      return 'The provider marked this invoice refunded. The preorder no longer applies.'
  }
}

const NOTICE_TEXT: Record<string, string> = {
  provider_unavailable: 'The payment provider did not answer. Nothing changed. Try refreshing again in a moment.',
  provider_rejected: 'The payment provider refused to create an invoice. Nothing was created. You can try again.',
  invoice_creation_outcome_unknown: 'The payment provider did not answer clearly, so we stopped instead of risking a second invoice.',
}

const ERROR_TEXT: Record<string, string> = {
  checkout_disabled: 'Checkout is closed on this deployment.',
  order_not_found: 'No order matches that recovery code.',
  recovery_code_required: 'Enter your recovery code first.',
  invoice_creation_in_progress: 'Your invoice is still being created. Refresh in a few seconds.',
  action_not_allowed: 'That is not possible for this order right now.',
  quote_limit_reached: 'This order has used all its quotes. Start a new order.',
  invalid_refund_address: 'That is not a valid shielded Zcash address (u1… or zs1…). Transparent t-addresses are not accepted.',
  nothing_to_refund: 'Nothing has been received for this order, so there is nothing to refund. Cancel it instead.',
  refund_already_requested: 'A refund has already been requested for this order.',
  order_store_unavailable: 'Our order database is unavailable. Nothing changed. Try again shortly.',
  conflict_retry: 'Another request changed this order at the same moment. Try again.',
}

class ApiError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

let code = ''
let fixtureMode = false

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (code) headers.set('authorization', `Bearer ${code}`)
  if (init.body) headers.set('content-type', 'application/json')
  let res: Response
  try {
    res = await fetch(path, { ...init, headers, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' })
  } catch {
    throw new ApiError('network')
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new ApiError(body.error ?? `http_${res.status}`)
  return body as T
}

const action = (name: string, extra: Record<string, string> = {}) =>
  api<OrderView>('/api/checkout/order', { method: 'POST', body: JSON.stringify({ action: name, ...extra }) })

// ---- Rendering ---------------------------------------------------------------------------------

const orderBox = $('co-order')
const notice = $('co-notice')

function show(id: string, on: boolean) {
  $(id).hidden = !on
}

function say(el: HTMLElement, text: string) {
  el.textContent = text
}

function render(v: OrderView, focus = true) {
  orderBox.hidden = false
  say($('co-state'), STATE_LABEL[v.state])
  $('co-state').dataset.state = v.state
  const reason = v.stateReason ? ` (${v.stateReason.replaceAll('_', ' ')})` : ''
  say($('co-status'), stateMessage(v) + (['quote_rejected', 'needs_resolution', 'reconciliation_required', 'quarantined'].includes(v.state) ? reason : ''))
  notice.hidden = !v.notice
  say(notice, v.notice ? NOTICE_TEXT[v.notice] ?? v.notice : '')

  show('co-pay', Boolean(v.payment))
  if (v.payment) {
    say($('co-amount'), v.payment.amountZec)
    say($('co-zatoshis'), `(${v.payment.amountZatoshis.toLocaleString('en')} zatoshis)`)
    say($('co-address'), v.payment.address)
    say($('co-expires'), new Date(v.payment.expiresAt).toLocaleString())
    say($('co-reference'), v.payment.reference)
    $<HTMLAnchorElement>('co-wallet').href = v.payment.uri
  }
  show('co-received', Boolean(v.received))
  if (v.received) {
    say($('co-received-zec'), v.received.receivedZec)
    say($('co-received-quote'), v.received.quotedZec ? `of ${v.received.quotedZec} ZEC quoted` : '')
  }
  show('co-receipt', Boolean(v.receipt))
  if (v.receipt) say($('co-receipt-id'), v.receipt.revoked ? `${v.receipt.id} (revoked)` : v.receipt.id)

  show('co-invoice', v.actions.createInvoice)
  show('co-refresh', v.actions.refresh)
  show('co-quote', v.actions.newQuote)
  show('co-cancel', v.actions.cancel)
  show('co-refund', v.actions.requestRefund)
  show('co-refund-done', Boolean(v.refundRequest))
  if (v.refundRequest) say($('co-refund-done'), `Refund requested to ${v.refundRequest.address}. An operator handles it manually.`)
  show('co-fixture', fixtureMode)
  if (focus) $('co-status-title').focus()
}

function fail(error: unknown, target: HTMLElement = notice) {
  const key = error instanceof ApiError ? error.code : 'unknown'
  target.hidden = false
  say(target, ERROR_TEXT[key] ?? 'Something went wrong. Nothing was charged. Try again.')
}

async function run(button: HTMLButtonElement | null, work: () => Promise<OrderView>) {
  if (button) button.disabled = true
  try {
    render(await work())
  } catch (error) {
    fail(error)
  } finally {
    if (button) button.disabled = false
  }
}

// ---- Wiring ------------------------------------------------------------------------------------

function wire() {
  const codeBox = $('co-code-box')
  const codeInput = $<HTMLInputElement>('co-code')
  const saved = $<HTMLInputElement>('co-code-saved')
  const invoiceBtn = $<HTMLButtonElement>('co-invoice')

  $('co-new').addEventListener('click', async (event) => {
    const button = event.currentTarget as HTMLButtonElement
    button.disabled = true
    try {
      const created = await api<{ recoveryCode: string; order: OrderView }>('/api/checkout/orders', { method: 'POST', body: '{}' })
      code = created.recoveryCode
      codeInput.value = code
      codeBox.hidden = false
      saved.checked = false
      render(created.order, false)
      invoiceBtn.disabled = true
      codeInput.focus()
      codeInput.select()
    } catch (error) {
      fail(error, $('co-start-msg'))
    } finally {
      button.disabled = false
    }
  })

  // Getting an invoice waits until the buyer confirms the code is saved.
  saved.addEventListener('change', () => {
    invoiceBtn.disabled = !saved.checked
  })

  $('co-code-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeInput.value)
      say($('co-status'), 'Recovery code copied. Keep it somewhere private.')
    } catch {
      codeInput.select()
    }
  })

  $('co-address-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('co-address').textContent ?? '')
      say($('co-status'), 'Address copied.')
    } catch {
      /* the address stays visible for manual copy */
    }
  })

  $<HTMLFormElement>('co-recover').addEventListener('submit', async (event) => {
    event.preventDefault()
    const input = $<HTMLInputElement>('co-recover-code')
    const candidate = input.value.trim()
    const previous = code
    code = candidate
    try {
      const view = await api<OrderView>('/api/checkout/order')
      input.value = ''
      codeBox.hidden = true
      say($('co-start-msg'), '')
      render(view)
    } catch (error) {
      code = previous
      fail(error, $('co-start-msg'))
    }
  })

  invoiceBtn.addEventListener('click', () => {
    codeBox.hidden = true
    codeInput.value = ''
    void run(invoiceBtn, () => action('create_invoice'))
  })
  $('co-refresh').addEventListener('click', (e) => void run(e.currentTarget as HTMLButtonElement, () => action('refresh')))
  $('co-quote').addEventListener('click', (e) => void run(e.currentTarget as HTMLButtonElement, () => action('new_quote')))
  $('co-cancel').addEventListener('click', (e) => void run(e.currentTarget as HTMLButtonElement, () => action('cancel')))
  $<HTMLFormElement>('co-refund').addEventListener('submit', (event) => {
    event.preventDefault()
    const address = $<HTMLInputElement>('co-refund-address').value.trim()
    void run(null, () => action('request_refund', { refundAddress: address }))
  })
  document.querySelectorAll<HTMLButtonElement>('#co-fixture [data-event]').forEach((button) => {
    button.addEventListener('click', () => void run(button, () => action('fixture_event', { event: button.dataset.event ?? '' })))
  })
}

async function boot() {
  let config: Config
  try {
    config = await api<Config>('/api/checkout/orders')
  } catch {
    // 503 from a deployment, 404 from a static host: either way, closed. The default banner stays.
    return
  }
  fixtureMode = config.mode === 'fixture'
  // Only the local fixture runtime answers today; anything else keeps the closed banner.
  if (!fixtureMode) return
  const banner = $('co-mode')
  banner.className = 'banner banner-fixture'
  banner.replaceChildren()
  const strong = document.createElement('strong')
  strong.textContent = 'Fixture mode: simulated provider, test data only.'
  banner.append(strong, ' Addresses here are fake and unpayable. No real payment can be made, and no order is kept after this server stops.')

  const list = $('co-blockers')
  for (const id of config.blockers) {
    const li = document.createElement('li')
    li.textContent = BLOCKER_TEXT[id] ?? id
    list.append(li)
  }
  $('co-blockers-wrap').hidden = config.blockers.length === 0

  const { offer } = config
  say($('offer-title'), offer.title)
  say($('offer-price'), offer.priceLabel)
  say($('offer-summary'), offer.summary)
  say($('offer-refunds'), offer.refundTerms)
  say($('offer-version'), `Terms version ${offer.version}${offer.approved ? '' : ', not approved: shown for testing only'}.`)
  $('co-app').hidden = false
  wire()
}

void boot()
