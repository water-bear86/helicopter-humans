import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const COMMAND = 'npx --yes expose402@0.1.0'
test('guided start explains prerequisites, local scope, demo and whole-thread impact', async ({ page }, testInfo) => {
  await page.goto('/#start')
  const section = page.locator('#start')
  await expect(section).toContainText('LangGraph SQLite')
  await expect(section).toContainText('Node.js 24 or newer')
  await expect(section).toContainText('invented demo')
  await expect(section).toContainText('entire saved history and pending writes')
  await expect(section).toContainText('cancellation removes nothing')
  await expect(section).toContainText('cannot erase blockchain')
  await expect(page.locator('#start-command')).toHaveText(COMMAND)
  await expect(section.getByRole('link', { name: 'Read the local guide' })).toBeVisible()
  await section.screenshot({ path: testInfo.outputPath('guided-start.png') })
})

test('copy button copies the exact registry command; denial selects it with useful help', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { document.documentElement.dataset.copied = text } } })
  })
  await page.goto('/#start')
  await page.getByRole('button', { name: 'Copy start command' }).click()
  await expect(page.locator('#copy-status')).toHaveText('Copied. Paste it into your terminal.')
  expect(await page.locator('html').getAttribute('data-copied')).toBe(COMMAND)
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied') } } }))
  await page.getByRole('button', { name: 'Copy start command' }).click()
  await expect(page.locator('#copy-status')).toHaveText('Command selected. Copy it with Ctrl+C or ⌘C.')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(COMMAND)
})

test('package, guide and advanced source downloads match the production build', async ({ page }) => {
  await page.goto('/#start')
  await page.getByText('Advanced downloads', { exact: true }).click()
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download the npm package archive' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('expose402-0.1.0.tgz')
  const bytes = await readFile((await download.path())!)
  expect(bytes).toEqual(await readFile('dist/expose402-0.1.0.tgz'))
  const manifest = await (await page.request.get('/traces-sha256.json')).json() as { package: string; version: string; files: Record<string, string>; archiveFiles: string[] }
  expect(manifest.package).toBe('expose402')
  expect(manifest.version).toBe('0.1.0')
  expect(manifest.files[download.suggestedFilename()]).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(manifest.archiveFiles).toHaveLength(7)
  const guide = await (await page.request.get('/traces-guide.txt')).text()
  expect(guide).toContain(COMMAND)
  expect(guide).not.toContain('not published to the npm registry')
  expect(manifest.files['traces-guide.txt']).toBe(createHash('sha256').update(guide).digest('hex'))
  for (const [url, file] of [['/traces-guide.txt', 'dist/traces-guide.txt'], ['/memory-cleaner.py', 'tools/memory-cleaner/memory_cleaner.py'], ['/memory-cleaner-guide.txt', 'docs/PAYMENT_TRACE_CLEANER.md'], ['/z402-design.txt', 'docs/Z402_DESIGN.md']]) {
    const response = await page.request.get(url)
    expect(response.ok()).toBeTruthy()
    expect(await response.body()).toEqual(await readFile(file))
  }
})
