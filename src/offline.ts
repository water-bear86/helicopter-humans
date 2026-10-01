import { redact } from './redact'

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

const source = el<HTMLTextAreaElement>('source')
const terms = el<HTMLTextAreaElement>('terms')
const output = el<HTMLTextAreaElement>('output')
const file = el<HTMLInputElement>('file')
const reviewed = el<HTMLInputElement>('reviewed')
const save = el<HTMLButtonElement>('save')
const copy = el<HTMLButtonElement>('copy')
const status = el<HTMLParagraphElement>('status')
const MAX_BYTES = 2 * 1024 * 1024
let ready = false
let revision = 0
let downloadUrl: string | undefined

function revokeDownload() {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl)
  downloadUrl = undefined
}

function exportState() {
  save.disabled = copy.disabled = !ready || !reviewed.checked
}

function invalidate() {
  revision++
  ready = false
  reviewed.checked = false
  reviewed.disabled = true
  output.value = ''
  revokeDownload()
  exportState()
  status.textContent = 'Prepare a new preview, then review it before exporting.'
}

function clear() {
  invalidate()
  source.value = terms.value = file.value = ''
  status.textContent = 'Fields cleared. Existing files and clipboard contents are unchanged.'
}

// A hosted copy cannot accept real logs. Save the single file and open it locally.
if (location.protocol !== 'file:') {
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button').forEach(control => { control.disabled = true })
  status.textContent = 'Save this HTML file, then open the saved file locally to use the tool. This hosted copy accepts no logs.'
} else {
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button').forEach(control => { control.disabled = false })
  reviewed.disabled = true
  exportState()
  source.addEventListener('input', invalidate)
  terms.addEventListener('input', invalidate)
  output.addEventListener('input', () => {
    reviewed.checked = false
    exportState()
    status.textContent = 'Preview edited. Review the changed copy before exporting.'
  })
  reviewed.addEventListener('change', exportState)
  el('clear').addEventListener('click', clear)
  window.addEventListener('pagehide', clear)

  file.addEventListener('change', async () => {
    invalidate()
    source.value = ''
    const selected = file.files?.[0]
    if (!selected) return
    const ticket = revision
    if (selected.size > MAX_BYTES) {
      file.value = ''
      status.textContent = 'Choose a text excerpt up to 2 MiB. Larger files were not read.'
      return
    }
    try {
      const bytes = await selected.arrayBuffer()
      if (ticket !== revision) return
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (text.includes('\0')) throw new Error('binary file')
      source.value = text
      file.value = ''
      status.textContent = 'Text loaded locally. Add private names or phrases below, then prepare a preview.'
    } catch {
      if (ticket !== revision) return
      file.value = ''
      status.textContent = 'Could not read this as UTF-8 text. Use a smaller plain-text excerpt.'
    }
  })

  el('prepare').addEventListener('click', () => {
    invalidate()
    if (!source.value.trim()) {
      status.textContent = 'Add a text excerpt first.'
      return
    }
    if (new TextEncoder().encode(source.value).length > MAX_BYTES) {
      status.textContent = 'Use a text excerpt up to 2 MiB.'
      return
    }
    const literals = terms.value.split(/\r?\n/).map(term => term.trim()).filter(Boolean)
    if (literals.length > 200 || terms.value.length > 16000) {
      status.textContent = 'Use up to 200 custom phrases, totalling at most 16,000 characters.'
      return
    }
    const result = redact(source.value, undefined, literals)
    output.value = result.text
    ready = true
    reviewed.disabled = false
    const details = Object.entries(result.counts).map(([key, count]) => `${count} ${key.toLowerCase().replaceAll('_', ' ')}`).join(', ')
    status.textContent = `${result.total} matches replaced${details ? `: ${details}` : ''}. Review the entire preview; unmatched private text remains.`
  })

  save.addEventListener('click', () => {
    if (save.disabled) return
    revokeDownload()
    downloadUrl = URL.createObjectURL(new Blob([output.value], { type: 'text/plain;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = 'reviewed-excerpt.txt'
    link.click()
    status.textContent = 'Exported the reviewed preview. The original file was not modified.'
  })

  copy.addEventListener('click', async () => {
    if (copy.disabled) return
    const ticket = revision
    try {
      await navigator.clipboard.writeText(output.value)
      if (ticket === revision) status.textContent = 'Reviewed preview copied. Your clipboard is now another copy; clear it when finished.'
    } catch {
      if (ticket !== revision) return
      output.select()
      status.textContent = 'Clipboard access was blocked. Save the reviewed excerpt, or copy the selected preview manually.'
    }
  })
}
