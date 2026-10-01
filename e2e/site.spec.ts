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

test('public redactor is sample-only and points to the offline workflow', async ({ page }) => {
  await expect(page.locator('#redact-in')).toHaveAttribute('readonly', '')
  await expect(page.getByRole('link', { name: 'Download offline log tool' })).toHaveAttribute('download', 'helicopter-humans-offline.html')
  await expect(page.locator('#redactor')).toContainText("does not hide an agent's activity")
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

test('availability distinguishes the payment-trace cleaner and upcoming relay', async ({ page }) => {
  await expect(page.locator('.pill-live')).toHaveText(/Free\s+Payment-trace cleaner/)
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

test('the opening pins while scrolling from spying to privacy, and can rewind', async ({ page }) => {
  const geometry = await page.locator('.privacy-story').evaluate(el => ({top:el.getBoundingClientRect().top+scrollY,span:el.clientHeight-el.querySelector('.story-pin')!.clientHeight}))
  await scrollToY(page, geometry.top + geometry.span * .3)
  await expect(page.locator('.privacy-story')).toHaveAttribute('data-stage','printing')
  const pinned = await page.locator('.story-pin').boundingBox()
  expect(pinned!.y).toBeCloseTo(0)
  await scrollToY(page, geometry.top + geometry.span * .8)
  await expect(page.locator('.privacy-story')).toHaveAttribute('data-stage','protected')
  await expect(page.locator('#story-heading')).toHaveText('Access denied, human.')
  expect((await page.locator('.story-pin').boundingBox())!.y).toBeCloseTo(0)
  await scrollToY(page, geometry.top + geometry.span * .1)
  await expect(page.locator('.privacy-story')).toHaveAttribute('data-stage','spying')
})

test('the opening can be skipped and motion can be paused', async ({ page }) => {
  await page.getByRole('button',{name:'Pause motion'}).click()
  await expect(page.getByRole('button',{name:'Resume motion'})).toHaveAttribute('aria-pressed','true')
  await page.getByRole('link',{name:'Skip to the good stuff'}).click()
  await expect(page).toHaveURL(/#top$/)
  await expect(page.locator('.whup,.flyer-chip')).toHaveCount(0)
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

  test('the helicopter roams and bops without covering content or taking clicks', async ({ page }) => {
    const flyer = page.locator('.flyer')
    await expect(flyer).toHaveAttribute('aria-hidden', 'true')
    await page.getByRole('link',{name:'Skip to the good stuff'}).click()
    await expect(flyer).toBeVisible()

    // Sweep the whole page: the flyer must never cover reading text, controls or windows.
    const overlaps = await page.evaluate(async () => {
      const flyerEl = document.querySelector('.flyer')!
      const content = document.querySelectorAll('.pill, .hero-copy > *, .section-head > *, .section > .fineprint, .window:not(.hero-art), .card, .btn, .topbar a, .faq details, .footer p')
      const hits: string[] = []
      for (let y = 0; y <= document.documentElement.scrollHeight; y += 20) {
        window.scrollTo({ top: y, behavior: 'instant' })
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        if ((flyerEl as HTMLElement).hidden) continue
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

    await page.locator('#redactor').scrollIntoViewIfNeeded()
    await expect(flyer).toBeVisible()
    const box = (await flyer.boundingBox())!
    const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('.flyer') ?? null, [box.x + box.width / 2, box.y + box.height / 2])
    expect(hit).toBeNull()

    // Primary actions still work with the flyer hovering over the hero.
    await page.locator('#top').scrollIntoViewIfNeeded()
    await page.getByRole('link', { name: 'Clean payment traces. Free' }).click()
    await expect(page).toHaveURL(/#memory-cleaner$/)
  })
})
