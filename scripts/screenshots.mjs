import { chromium, devices } from '@playwright/test'
// Usage: npm run build && npx vite preview --port 4174, then node scripts/screenshots.mjs
const b = await chromium.launch()
const d = await b.newPage({ viewport: { width: 1440, height: 900 } })
await d.goto('http://localhost:4174/')
await d.screenshot({ path: 'screenshots/desktop-hero.png' })
await d.getByRole('button', { name: 'Load embarrassing sample' }).click()
for (const c of ['peek', 'shut door', 'peek']) await d.locator(`.chip[data-cmd="${c}"]`).click()
await d.screenshot({ path: 'screenshots/desktop-full.png', fullPage: true })
const m = await (await b.newContext({ ...devices['iPhone 13'] })).newPage()
await m.goto('http://localhost:4174/')
await m.screenshot({ path: 'screenshots/mobile-full.png', fullPage: true })
await b.close()
