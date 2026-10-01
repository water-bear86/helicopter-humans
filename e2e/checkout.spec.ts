// Checkout preview against the local fixture runtime (vite dev with CHECKOUT_MODE=fixture): real
// route handlers, real client/parser/URI checks, in-memory store, simulated provider.
// Set CHECKOUT_SCREENSHOTS=1 to save evidence screenshots under screenshots/.
import { expect, test, type Page } from '@playwright/test'
import { encodeBech32m } from '../src/checkout/address'

const SHOTS = Boolean(process.env.CHECKOUT_SCREENSHOTS)

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `screenshots/checkout-${test.info().project.name}-${name}.png`, fullPage: true })
}

async function startOrder(page: Page): Promise<string> {
  await page.goto('/checkout.html')
  await expect(page.locator('#co-mode')).toContainText('Fixture mode')
  await page.getByRole('button', { name: 'Start a private order' }).click()
  const field = page.getByLabel('Your private recovery code. Shown once. Save it now.')
  await expect(field).toHaveValue(/^hhr_[A-Za-z0-9_-]{43}$/)
  return field.inputValue()
}

async function getInvoice(page: Page) {
  await page.getByLabel('I have saved my recovery code').check()
  await page.getByRole('button', { name: 'Get invoice' }).click()
}

const fixture = (page: Page, name: string) => page.locator('#co-fixture').getByRole('button', { name }).click()
const refresh = (page: Page) => page.getByRole('button', { name: 'Refresh status' }).click()
const state = (page: Page) => page.locator('#co-state')

test('closed on the static build: no offer, no order controls', async ({ page }) => {
  // The dev server serves the fixture API; a 404 from a static host is simulated by blocking it.
  await page.route('**/api/checkout/**', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"checkout_disabled"}' }))
  await page.goto('/checkout.html')
  await expect(page.locator('#co-mode')).toContainText('Checkout is closed.')
  await expect(page.locator('#co-app')).toBeHidden()
  await expect(page.getByRole('button', { name: 'Start a private order' })).toBeHidden()
})

test('fixture mode is labelled, shows draft terms and every readiness blocker', async ({ page }) => {
  await page.goto('/checkout.html')
  await expect(page.locator('#co-mode')).toContainText('Fixture mode: simulated provider, test data only.')
  await expect(page.locator('#co-mode')).toContainText('fake and unpayable')
  await expect(page.locator('#offer-version')).toContainText('not approved')
  await expect(page.locator('#offer-price')).toHaveText('US$9 once')
  await expect(page.locator('#co-blockers li')).toHaveCount(5)
  await shot(page, '01-landing')
})

test('keyboard-only happy path: order, save code, invoice, pay, confirm, receipt', async ({ page }) => {
  await page.goto('/checkout.html')
  await page.getByRole('button', { name: 'Start a private order' }).focus()
  await page.keyboard.press('Enter')
  const codeField = page.getByLabel('Your private recovery code. Shown once. Save it now.')
  await expect(codeField).toBeFocused()
  const code = await codeField.inputValue()
  const invoiceBtn = page.getByRole('button', { name: 'Get invoice' })
  await expect(invoiceBtn).toBeDisabled()
  await shot(page, '02-recovery-code')
  await page.getByLabel('I have saved my recovery code').focus()
  await page.keyboard.press('Space')
  await expect(invoiceBtn).toBeEnabled()
  await invoiceBtn.focus()
  await page.keyboard.press('Enter')

  await expect(state(page)).toHaveText('Awaiting payment')
  await expect(page.locator('#co-status-title')).toBeFocused()
  await expect(page.locator('#co-amount')).toHaveText(/^0\.\d{1,8}$/)
  await expect(page.locator('#co-zatoshis')).toContainText('zatoshis')
  await expect(page.locator('#co-address')).toHaveText(/^u1[a-z0-9]{60,}$/)
  await expect(page.locator('#co-expires')).not.toBeEmpty()
  await expect(page.locator('.fee')).toContainText('one recipient, this exact amount, no surcharge')
  const href = await page.locator('#co-wallet').getAttribute('href')
  expect(href).toMatch(/^zcash:u1[a-z0-9]+\?amount=0\.\d+&memo=[A-Za-z0-9_-]+$/)
  expect(href).not.toContain('address.1')
  await expect(page.locator('#co-code-box')).toBeHidden()
  await shot(page, '03-awaiting-payment')

  // The code never reaches the URL or storage.
  expect(page.url()).not.toContain(code)
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie)).not.toContain('hhr_')

  await fixture(page, 'Simulate full payment')
  await refresh(page)
  await expect(state(page)).toHaveText('Payment detected')
  await expect(page.locator('#co-pay')).toBeHidden()
  await expect(page.locator('#co-status')).toContainText('Do not send it again')
  await shot(page, '04-detected')
  await fixture(page, 'Simulate confirmation')
  await refresh(page)
  await expect(state(page)).toHaveText('Confirmed')
  await expect(page.locator('#co-receipt')).toBeVisible()
  await expect(page.locator('#co-receipt')).toContainText('not a working privacy service')
  await shot(page, '05-confirmed-receipt')
})

test('underpayment: address hidden, no second-payment prompt, refund request with validation', async ({ page }) => {
  await startOrder(page)
  await getInvoice(page)
  await fixture(page, 'Simulate underpayment')
  await refresh(page)
  await expect(state(page)).toHaveText('Needs review')
  await expect(page.locator('#co-status')).toContainText('Do not send more')
  await expect(page.locator('#co-pay')).toBeHidden()
  await expect(page.locator('#co-received')).toContainText('of')
  await shot(page, '06-underpaid')

  const field = page.getByLabel('Refund to a shielded Zcash address (u1… or zs1…)')
  await field.fill('t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU')
  await field.press('Enter')
  await expect(page.locator('#co-notice')).toContainText('not a valid shielded Zcash address')
  const address = encodeBech32m('u', Array.from({ length: 120 }, (_, i) => (i * 7) % 32))
  await field.fill(address)
  await page.getByRole('button', { name: 'Request refund' }).click()
  await expect(page.locator('#co-refund-done')).toContainText('Refund requested to u1')
  await expect(page.locator('#co-refund-done')).not.toContainText(address)
  await expect(page.locator('#co-refund')).toBeHidden()
  await shot(page, '07-refund-requested')
})

test('expiry: nothing payable, then a deliberate new quote with a fresh address', async ({ page }) => {
  await startOrder(page)
  await getInvoice(page)
  const first = await page.locator('#co-address').textContent()
  await fixture(page, 'Simulate expiry')
  await refresh(page)
  await expect(state(page)).toHaveText('Quote expired')
  await expect(page.locator('#co-pay')).toBeHidden()
  await shot(page, '08-expired')
  await page.getByRole('button', { name: 'Get a new quote' }).click()
  await expect(state(page)).toHaveText('Awaiting payment')
  await expect(page.locator('#co-address')).not.toHaveText(first ?? '')
})

test('a fee recipient in the provider URI is refused before anything is shown', async ({ page }) => {
  await startOrder(page)
  await page.getByLabel('I have saved my recovery code').check()
  await fixture(page, 'Next quote adds a fee recipient')
  await page.getByRole('button', { name: 'Get invoice' }).click()
  await expect(state(page)).toHaveText('Quote rejected')
  await expect(page.locator('#co-status')).toContainText('unapproved fee recipient')
  await expect(page.locator('#co-pay')).toBeHidden()
  await shot(page, '09-fee-recipient-rejected')
})

test('a provider timeout stops for review instead of making a second invoice', async ({ page }) => {
  await startOrder(page)
  await page.getByLabel('I have saved my recovery code').check()
  await fixture(page, 'Next quote times out')
  await page.getByRole('button', { name: 'Get invoice' }).click()
  await expect(state(page)).toHaveText('Needs review', { timeout: 10_000 })
  await expect(page.locator('#co-notice')).toContainText('stopped instead of risking a second invoice')
  await expect(page.getByRole('button', { name: 'Get invoice' })).toBeHidden()
  await expect(page.getByRole('button', { name: 'Get a new quote' })).toBeHidden()
  await shot(page, '10-timeout-review')
})

test('private recovery: the code reopens the order in a fresh tab; a public reference does not', async ({ page, context }) => {
  const code = await startOrder(page)
  await getInvoice(page)
  await expect(page.locator('#co-address')).not.toBeEmpty()
  const address = await page.locator('#co-address').textContent()
  const reference = await page.locator('#co-reference').textContent()

  const other = await context.newPage()
  await other.goto('/checkout.html')
  const field = other.getByLabel('Have a recovery code? Open your order')
  await field.fill(reference ?? '')
  await field.press('Enter')
  await expect(other.locator('#co-start-msg')).toContainText('Enter your recovery code first')
  await field.fill(`hhr_${'Z'.repeat(43)}`)
  await field.press('Enter')
  await expect(other.locator('#co-start-msg')).toContainText('No order matches')
  await field.fill(code)
  await field.press('Enter')
  await expect(other.locator('#co-address')).toHaveText(address ?? '')
  await expect(field).toHaveValue('')
  await shot(other, '11-recovered')
})

test('cancel an unpaid order', async ({ page }) => {
  await startOrder(page)
  await getInvoice(page)
  await page.getByRole('button', { name: 'Cancel order' }).click()
  await expect(state(page)).toHaveText('Cancelled')
  await expect(page.locator('#co-pay')).toBeHidden()
  await expect(page.locator('#co-status')).toContainText('Do not pay its invoice')
})

test('no horizontal overflow and no third-party requests on the checkout page', async ({ page, baseURL }) => {
  const external: string[] = []
  page.on('request', (req) => {
    if (!req.url().startsWith(baseURL ?? '')) external.push(req.url())
  })
  await startOrder(page)
  await getInvoice(page)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBe(0)
  expect(external).toEqual([])
})
