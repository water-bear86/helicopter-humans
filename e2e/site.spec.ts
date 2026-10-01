import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test('the landing page leads to payment discovery and its guide', async ({ page }) => {
  await expect(page).toHaveTitle('Helicopter Humans | Find and clean up saved payment traces')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your agent paid. Its memory remembers.')
  await page.getByRole('link', { name: 'Skip to the good stuff' }).click()
  await page.getByRole('link', { name: 'Clean payment traces. Free' }).click()
  await expect(page).toHaveURL(/#memory-cleaner$/)
  await expect(page.getByRole('link', { name: 'Download payment-trace cleaner' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Read the local guide' })).toBeVisible()
  await expect(page.locator('#how')).toContainText('entire saved history and pending writes')
})

test('navigation resolves to current content and retired offers are absent', async ({ page }) => {
  for (const link of await page.getByRole('navigation').getByRole('link').all()) {
    const target = await link.getAttribute('href')
    expect(target).toMatch(/^#/)
    await expect(page.locator(target!)).toHaveCount(1)
  }
  await expect(page.locator('body')).not.toContainText(/redactor|Founding Agent Pass|privacy relay|shielded ZEC|classified[.]exe/i)
  await expect(page.locator('input,textarea,form')).toHaveCount(0)
})

test('availability separates the free cleaner from the z402 design', async ({ page }) => {
  await expect(page.locator('.pill-live')).toHaveText(/Free\s+Payment-trace cleaner/)
  await expect(page.locator('.pill-off')).toHaveText(/Design stage\s+z402 payment privacy/)
  await page.getByRole('link', { name: 'Next flight: z402' }).click()
  await expect(page).toHaveURL(/#z402$/)
  await expect(page.locator('#z402')).toContainText('A protected payment route is still to be built')
})

test('the FAQ explains whole-thread removal and local-only scope', async ({ page }) => {
  await page.getByText('Does it remove just the receipt?', { exact: true }).click()
  await expect(page.locator('details[open]')).toContainText('entire saved history and pending writes')
  await expect(page.locator('details[open]')).toContainText('blockchain, provider or backup records')
})

test('the page makes no third-party requests and renders without runtime errors', async ({ page, baseURL }) => {
  const external: string[] = []
  const errors: string[] = []
  page.on('request', req => { if (!req.url().startsWith(baseURL ?? '')) external.push(req.url()) })
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeAttached()
  await expect(page.locator('vite-error-overlay')).toHaveCount(0)
  expect(external).toEqual([])
  expect(errors).toEqual([])
})

test('the checkout preview page remains closed on the static build', async ({ page }) => {
  await page.goto('/checkout.html')
  await expect(page.locator('#co-mode')).toContainText('Checkout is closed.')
  await expect(page.locator('#co-app')).toBeHidden()
})

test('reduced motion stops animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const name = await page.locator('.ticker-track').evaluate(el => getComputedStyle(el).animationName)
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
  await expect(page.locator('#story-heading')).toHaveText('Less history. Less hovering.')
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

    await page.locator('#memory-cleaner').scrollIntoViewIfNeeded()
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
