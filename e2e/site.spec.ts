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

test('terminal status matches the disabled ZEC prototype', async ({ page }) => {
  const input = page.getByLabel('agent@bedroom:~$')
  await input.fill('status')
  await input.press('Enter')
  const log = page.getByRole('log')
  await expect(log).toContainText('direct shielded ZEC payment check')
  await expect(log).toContainText('payment collection (no quote, no address, no charge)')
  await expect(log).not.toContainText('x402')
})

test('redactor copy does not claim Windows path coverage', async ({ page }) => {
  await expect(page.locator('#redactor')).toContainText('macOS/Linux home-folder usernames')
  await expect(page.getByText('It does not catch Windows paths')).toBeAttached()
})

test('checkout stays closed even when a checkout URL was set at build time', async ({ page }) => {
  // playwright.config.ts builds with VITE_CHECKOUT_URL=https://pay.example.com/should-never-open.
  const checkout = page.locator('#checkout-btn')
  await expect(checkout).toHaveAttribute('href', '#pricing')
  expect(await page.content()).not.toContain('pay.example.com')
  const scripts = await page.evaluate(async () => {
    const urls = [...document.querySelectorAll<HTMLScriptElement>('script[src]')].map((s) => s.src)
    return (await Promise.all(urls.map((u) => fetch(u).then((r) => r.text())))).join('\n')
  })
  expect(scripts).not.toContain('pay.example.com')
})

test('the free redactor never calls a server route', async ({ page }) => {
  const api: string[] = []
  page.on('request', (req) => {
    if (new URL(req.url()).pathname.startsWith('/api/')) api.push(req.url())
  })
  await page.getByRole('button', { name: 'Load embarrassing sample' }).click()
  await page.getByRole('button', { name: 'Shred it' }).click()
  await expect(page.locator('#redact-summary')).toContainText('Shredded')
  expect(api).toEqual([])
})

test('the checkout preview page is closed on the static build', async ({ page }) => {
  await page.goto('/checkout.html')
  await expect(page.locator('#co-mode')).toContainText('Checkout is closed.')
  await expect(page.locator('#co-app')).toBeHidden()
})

test('checkout is visibly unavailable when not configured and does not navigate', async ({ page }) => {
  const checkout = page.locator('#checkout-btn')
  await expect(checkout).toHaveAttribute('aria-disabled', 'true')
  await expect(checkout).toHaveText('Passes coming soon')
  await expect(checkout).toBeDisabled()
  await checkout.click({ force: true })
  await expect(page).toHaveURL(/\/(#.*)?$/)
  await expect(page.locator('#checkout-note')).toBeVisible()
})

test('availability distinguishes the live redactor and upcoming relay', async ({ page }) => {
  await expect(page.locator('.pill-live')).toHaveText(/Live\s+Log redactor/)
  await expect(page.locator('.pill-off')).toHaveText(/Coming soon\s+Agent privacy relay/)
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

// ---- Scroll-linked helicopter ------------------------------------------

async function scrollToY(page: import('@playwright/test').Page, y: number) {
  await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y)
  // Let the coalesced animation frame run.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

const flightPose = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.querySelector('.flyer')?.getAttribute('style') ?? document.querySelector('.flight')?.getAttribute('transform'))

test('the helicopter patrols at idle and follows scrolling without a caption', async ({ page }) => {
  // Bring the scene into view on a phone; the desktop flyer remains visible throughout.
  await page.locator('.hero-art').scrollIntoViewIfNeeded()
  const start = await flightPose(page)
  await page.waitForTimeout(700)
  expect(await flightPose(page)).not.toEqual(start)
  await expect(page.locator('.whup, .flyer-chip')).toHaveCount(0)
  await scrollToY(page, 500)
  const middle = await flightPose(page)
  await scrollToY(page, 250)
  expect(await flightPose(page)).not.toEqual(middle)
})

test('the flight never causes horizontal overflow', async ({ page }) => {
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  for (const y of [0, 300, 700, height / 2, height]) {
    await scrollToY(page, y)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow).toBe(0)
  }
})

test('reduced motion keeps the helicopter parked in its scene', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await scrollToY(page, 500)
  await expect(page.locator('.flyer')).toHaveCount(0)
  expect(await page.locator('.flight').getAttribute('transform')).toBeNull()
  const rotor = await page.locator('.hero-art .rotor').evaluate((el) => getComputedStyle(el).animationName)
  expect(rotor).toBe('none')
})

test.describe('wide screens', () => {
  test.use({ viewport: { width: 1440, height: 900 } })

  test('the helicopter leaves the scene for the gutter without covering content or taking clicks', async ({ page }) => {
    const flyer = page.locator('.flyer')
    await expect(flyer).toHaveAttribute('aria-hidden', 'true')
    await expect(page.locator('.hero-art .flight')).toBeHidden()

    // Sweep the whole page: the flyer must never cover reading text, controls or windows.
    const overlaps = await page.evaluate(async () => {
      const flyerEl = document.querySelector('.flyer')!
      const content = document.querySelectorAll('.pill, .hero-copy > *, .section-head > *, .section > .fineprint, .window:not(.hero-art), .card, .btn, .topbar a, .faq details, .footer p')
      const hits: string[] = []
      for (let y = 0; y <= document.documentElement.scrollHeight; y += 20) {
        window.scrollTo({ top: y, behavior: 'instant' })
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const f = flyerEl.getBoundingClientRect()
        if (f.right > document.documentElement.clientWidth) hits.push(`viewport edge at ${y}`)
        for (const el of content) {
          const r = el.getBoundingClientRect()
          if (r.right > f.left && r.left < f.right && r.bottom > f.top && r.top < f.bottom) hits.push(`${el.className || el.tagName} at ${y}`)
        }
      }
      return hits
    })
    expect(overlaps).toEqual([])

    await scrollToY(page, 1200)
    const box = (await flyer.boundingBox())!
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.flyer') ?? null, [box.x + box.width / 2, box.y + box.height / 2])
    expect(hit).toBeNull()

    // Primary actions still work with the flyer hovering over the hero.
    await scrollToY(page, 0)
    await page.getByRole('link', { name: 'Redact a log now. Free' }).click()
    await expect(page).toHaveURL(/#redactor$/)
  })
})
