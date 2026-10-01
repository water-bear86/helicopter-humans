import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

test('payment-trace cleaner downloads the inspectable source and names its actual scope', async ({ page }, testInfo) => {
  await page.goto('/#memory-cleaner')
  const section = page.locator('#memory-cleaner')
  await expect(section).toContainText('LangGraph SQLite')
  await expect(section).toContainText("entire saved history and pending writes")
  await expect(section).toContainText('cannot erase blockchain')
  await expect(section).toContainText('design proposal')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('link', { name: 'Download payment-trace cleaner' }).click(),
  ])
  expect(download.suggestedFilename()).toBe('memory-cleaner.py')
  const bytes = await readFile((await download.path())!)
  expect(bytes).toEqual(await readFile('tools/memory-cleaner/memory_cleaner.py'))
  const manifest = await (await page.request.get('/memory-cleaner-sha256.json')).json() as Record<string, string>
  expect(manifest['memory-cleaner.py']).toBe(createHash('sha256').update(bytes).digest('hex'))
  for (const [url, file] of [['/memory-cleaner-guide.txt', 'docs/PAYMENT_TRACE_CLEANER.md'], ['/z402-design.txt', 'docs/Z402_DESIGN.md']]) {
    const response = await page.request.get(url)
    expect(response.ok()).toBeTruthy()
    expect(await response.body()).toEqual(await readFile(file))
  }
  await section.screenshot({ path: testInfo.outputPath('memory-cleaner.png') })
})
