import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const offline = pathToFileURL(resolve('dist/offline-redactor.html')).href

test('offline file masks custom/private text, requires review and exports only the preview', async ({ page }, testInfo) => {
  const requests: string[] = []
  const errors: string[] = []
  page.on('request', request => { if (!request.url().startsWith('file:')) requests.push(request.url()) })
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(offline)
  await expect(page).toHaveTitle(/Offline log preparation/)
  await page.locator('#file').setInputFiles({ name: 'invented.log', mimeType: 'text/plain', buffer: Buffer.from('Ada Lovelace {"token":"q"}\nprivate sentence\nretry at 09:00') })
  await expect(page.locator('#source')).toHaveValue(/Ada Lovelace/)
  await page.locator('#terms').fill('Ada Lovelace\nprivate sentence')
  await page.getByRole('button', { name: 'Prepare preview' }).click()
  await expect(page.locator('#output')).toHaveValue('[CUSTOM] {"token":"[SECRET]"}\n[CUSTOM]\nretry at 09:00')
  await expect(page.locator('#status')).toContainText('3 matches replaced')
  await expect(page.locator('#save')).toBeDisabled()
  await page.locator('#reviewed').check()
  await page.screenshot({ path: testInfo.outputPath('offline-preview.png'), fullPage: true })
  const downloadEvent = page.waitForEvent('download')
  await page.locator('#save').click()
  const download = await downloadEvent
  const text = await readFile((await download.path())!, 'utf8')
  expect(text).toBe('[CUSTOM] {"token":"[SECRET]"}\n[CUSTOM]\nretry at 09:00')
  await page.locator('#output').fill('retry at 09:00 only')
  await expect(page.locator('#save')).toBeDisabled()
  await page.locator('#reviewed').check()
  await expect(page.locator('#save')).toBeEnabled()
  await page.locator('#source').fill('different private input')
  await expect(page.locator('#output')).toHaveValue('')
  await expect(page.locator('#save')).toBeDisabled()
  await page.locator('#prepare').click()
  await expect(page.locator('#status')).toContainText('0 matches replaced')
  await expect(page.locator('#status')).toContainText('unmatched private text remains')
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
  await page.locator('#clear').click()
  await expect(page.locator('#source')).toHaveValue('')
  await expect(page.locator('#terms')).toHaveValue('')
  await expect(page.locator('#output')).toHaveValue('')
  await expect(page.locator('#reviewed')).not.toBeChecked()
  await page.reload()
  await expect(page.locator('#source')).toHaveValue('')
  expect(requests).toEqual([])
  expect(errors).toEqual([])
})

test('offline tool refuses oversized and binary files without allowing an export', async ({ page }) => {
  await page.goto(offline)
  await page.locator('#file').setInputFiles({ name: 'too-big.log', mimeType: 'text/plain', buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 'a') })
  await expect(page.locator('#status')).toContainText('Larger files were not read')
  await expect(page.locator('#source')).toHaveValue('')
  await page.locator('#file').setInputFiles({ name: 'binary.log', mimeType: 'text/plain', buffer: Buffer.from([0, 255, 127]) })
  await expect(page.locator('#status')).toContainText('Could not read this as UTF-8 text')
  await expect(page.locator('#save')).toBeDisabled()
})

test('CSP denies network and the hosted artifact accepts no real logs', async ({ page, baseURL }) => {
  await page.goto(offline)
  const sent: string[] = []
  page.on('request', request => sent.push(request.url()))
  const blocked = await page.evaluate(async () => {
    try { await fetch('https://example.invalid/private'); return false } catch { return true }
  })
  expect(blocked).toBe(true)
  expect(sent).toEqual([])
  await page.goto(`${baseURL}/offline-redactor.html`)
  await expect(page.locator('#source')).toBeDisabled()
  await expect(page.locator('#file')).toBeDisabled()
  await expect(page.locator('#prepare')).toBeDisabled()
  await expect(page.locator('#status')).toContainText('hosted copy accepts no logs')
})

test('terminal does not echo or keep unrecognised private input in its history', async ({ page }) => {
  await page.goto('/')
  const input = page.locator('#term-in')
  await input.fill('status')
  await input.press('Enter')
  await input.fill('redact private-acquisition')
  await input.press('Enter')
  await expect(page.locator('#term-out')).not.toContainText('private-acquisition')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('status')
})

test('without JavaScript the offline file accepts no input', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  try {
    const page = await context.newPage()
    await page.goto(offline)
    // Chromium's script-disable emulation does not expose noscript text. Check the
    // rendered document and actual input/export guard rather than that getter.
    await expect(page.getByRole('heading', { name: 'Pack a smaller paper trail.' })).toBeVisible()
    await expect(page.locator('#source')).toBeDisabled()
    await expect(page.locator('#file')).toBeDisabled()
    await expect(page.locator('#save')).toBeDisabled()
  } finally {
    await context.close()
  }
})
