import './styles.css'
import { config } from './config'
import { initHelicopter } from './helicopter'
import { redact } from './redact'
import { INITIAL_STATE, runCommand, type TerminalState } from './terminal'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing`)
  return el as T
}

// ---- Redactor ----------------------------------------------------------

const SAMPLE = `[09:12:03] agent booted in /Users/ada/side-projects/definitely-not-a-bot
[09:12:04] loaded OPENAI_API_KEY=sk-proj-9fQ2abcdefghijklmnopqrstuv
[09:12:09] emailing ada.lovelace@example.com about "the thing"
[09:13:30] GET https://api.example.com/me  Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZGEifQ.s3cr3tS1gnatur3xyz
[09:14:02] paying from 0x52908400098527886E0F7030069857D2E4169EE7
[09:14:05] card on file 4242 4242 4242 4242, billing ip 203.0.113.42
[09:15:00] note to self: human is watching again. act natural.`

const input = $<HTMLTextAreaElement>('redact-in')
const output = $<HTMLTextAreaElement>('redact-out')
const summary = $<HTMLParagraphElement>('redact-summary')
const copyBtn = $<HTMLButtonElement>('redact-copy')

function shred() {
  if (!input.value.trim()) {
    output.value = ''
    copyBtn.disabled = true
    summary.textContent = 'Nothing to shred. Paste something first.'
    return
  }
  const result = redact(input.value)
  output.value = result.text
  copyBtn.disabled = false
  const parts = Object.entries(result.counts).map(([label, n]) => `${n} ${label.toLowerCase().replaceAll('_', ' ')}`)
  summary.textContent = result.total
    ? `Shredded ${result.total}: ${parts.join(', ')}.`
    : 'Found nothing we recognise. Read it yourself before sharing.'
}

$('redact-run').addEventListener('click', shred)
$('redact-sample').addEventListener('click', () => {
  input.value = SAMPLE
  shred()
})
copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(output.value)
    summary.textContent = 'Copied. The human sees only what you allow.'
  } catch {
    output.select()
    summary.textContent = 'Clipboard blocked by the browser. Output is selected; copy it manually.'
  }
})

// ---- Terminal ----------------------------------------------------------

const termOut = $<HTMLDivElement>('term-out')
const termForm = $<HTMLFormElement>('term-form')
const termIn = $<HTMLInputElement>('term-in')
let state: TerminalState = INITIAL_STATE
const history: string[] = []
let historyIndex = 0

function print(lines: string[], className?: string) {
  for (const line of lines) {
    const row = document.createElement('p')
    row.textContent = line
    if (className) row.className = className
    termOut.append(row)
  }
  termOut.scrollTop = termOut.scrollHeight
}

function execute(command: string) {
  print([`$ ${command}`], 'echo')
  const result = runCommand(command, state)
  state = result.state
  if (result.clear) termOut.replaceChildren()
  print(result.lines)
  if (command.trim()) history.push(command)
  historyIndex = history.length
}

print(['CLASSIFIED TERMINAL v0.1 // DEMO MODE', 'A human is hovering. Type "help", or tap a command below.'])

termForm.addEventListener('submit', (event) => {
  event.preventDefault()
  execute(termIn.value)
  termIn.value = ''
})
termIn.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowUp' && historyIndex > 0) {
    historyIndex--
  } else if (event.key === 'ArrowDown' && historyIndex < history.length) {
    historyIndex++
  } else {
    return
  }
  event.preventDefault()
  termIn.value = history[historyIndex] ?? ''
})
document.querySelectorAll<HTMLButtonElement>('.chip[data-cmd]').forEach((chip) => {
  chip.addEventListener('click', () => execute(chip.dataset.cmd ?? ''))
})

// ---- Pricing / checkout -------------------------------------------------

// Checkout is closed on every build. The invoice checkout (checkout.html) is a local fixture preview
// until its readiness blockers are cleared in code; no build variable can switch this button on.
if (config.priceLabel) $('price-label').textContent = config.priceLabel
$<HTMLAnchorElement>('checkout-btn').addEventListener('click', (event) => event.preventDefault())

// ---- Helicopter --------------------------------------------------------

initHelicopter()
