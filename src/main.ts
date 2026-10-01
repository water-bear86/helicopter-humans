import './styles.css'
import { initHelicopter } from './helicopter'

initHelicopter()

const copyButton = document.querySelector<HTMLButtonElement>('#copy-command')
const command = document.querySelector<HTMLElement>('#start-command')
const copyStatus = document.querySelector<HTMLElement>('#copy-status')
copyButton?.addEventListener('click', async () => {
  if (!command || !copyStatus) return
  try {
    await navigator.clipboard.writeText(command.textContent?.trim() ?? '')
    copyStatus.textContent = 'Copied. Paste it into your terminal.'
  } catch {
    const range = document.createRange()
    range.selectNodeContents(command)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    copyStatus.textContent = 'Command selected. Copy it with Ctrl+C or ⌘C.'
  }
})
