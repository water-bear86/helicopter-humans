import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const files = {
  'memory-cleaner.py': 'tools/memory-cleaner/memory_cleaner.py',
  'memory-cleaner-guide.txt': 'docs/PAYMENT_TRACE_CLEANER.md',
  'z402-design.txt': 'docs/Z402_DESIGN.md',
}
const checksums = {}
for (const [name, source] of Object.entries(files)) {
  const bytes = await readFile(source)
  await writeFile(`dist/${name}`, bytes)
  checksums[name] = createHash('sha256').update(bytes).digest('hex')
}
await writeFile('dist/memory-cleaner-sha256.json', JSON.stringify(checksums, null, 2) + '\n')
console.log('Built local payment-trace cleaner, guide, design proposal and SHA-256 manifest')
