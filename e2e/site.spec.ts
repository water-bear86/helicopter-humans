import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('redactor shreds the sample and reports counts', async ({ page }) => {
  await page.getByRole('button', { name: 'Load embarrassing sample' }).click()
  const out = page.getByLabel('Declassified output')
  await expect(out).toHaveValue(/\[EMAIL\]/)
  await expect(out).not.toHaveValue(/ada\.lovelace@example\.com/)
  await expect(out).not.toHaveValue(/sk-proj-/)
  await expect(page.locator('#redact-summary')).toContainText('Shredded')
  await expect(page.getByRole('button', { name: 'Copy output' })).toBeEnabled()
})

test('redactor explains empty input instead of failing silently', async ({ page }) => {
  await page.getByRole('button', { name: 'Shred it' }).click()
  await expect(page.locator('#redact-summary')).toHaveText(/Nothing to shred/)
  await expect(page.getByRole('button', { name: 'Copy output' })).toBeDisabled()
})

test('terminal works from the keyboard: shut the door, then peeking is denied', async ({ page }) => {
  const input = page.getByLabel('agent@bedroom:~$')
  await input.fill('shut door')
  await input.press('Enter')
  await input.fill('peek')
  await input.press('Enter')
  await expect(page.getByRole('log')).toContainText('ACCESS DENIED.')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('peek')
})

test('checkout is visibly unavailable when not configured and does not navigate', async ({ page }) => {
  const checkout = page.locator('#checkout-btn')
  await expect(checkout).toHaveAttribute('aria-disabled', 'true')
  await expect(checkout).toHaveText('Checkout not open yet')
  await expect(checkout).toBeDisabled()
  await checkout.click({ force: true })
  await expect(page).toHaveURL(/\/(#.*)?$/)
  await expect(page.getByText('Checkout is not configured on this deployment.')).toBeVisible()
})

test('availability labels are honest', async ({ page }) => {
  await expect(page.locator('.pill-live')).toHaveText(/Live\s+Log redactor/)
  await expect(page.locator('.pill-off')).toHaveText(/Not built\s+Paid privacy relay/)
})

test('page makes no third-party requests', async ({ page, baseURL }) => {
  const external: string[] = []
  page.on('request', (req) => {
    if (!req.url().startsWith(baseURL ?? '')) external.push(req.url())
  })
  await page.reload()
  await page.getByRole('button', { name: 'Load embarrassing sample' }).click()
  expect(external).toEqual([])
})

test('reduced motion stops animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const name = await page.locator('.ticker-track').evaluate((el) => getComputedStyle(el).animationName)
  expect(name).toBe('none')
})
