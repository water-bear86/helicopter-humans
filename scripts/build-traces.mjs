import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const packed = JSON.parse(execFileSync(npm, ['pack', './packages/traces', '--ignore-scripts', '--json', '--pack-destination', 'dist'], { encoding: 'utf8' }))[0]
const allowed = ['LICENSE', 'README.md', 'package.json', 'bin/hh-traces.js', 'lib/cli.js', 'lib/markers.js', 'lib/store.js']
if (packed.files.length !== allowed.length || packed.files.some(file => !allowed.includes(file.path))) throw new Error('Unexpected file in trace package')
const bytes = await readFile(`dist/${packed.filename}`)
const guide = await readFile('packages/traces/README.md')
await writeFile('dist/traces-guide.txt', guide)
await writeFile('dist/traces-sha256.json', JSON.stringify({
  package: packed.name, version: packed.version,
  files: { [packed.filename]: createHash('sha256').update(bytes).digest('hex'), 'traces-guide.txt': createHash('sha256').update(guide).digest('hex') },
  archiveFiles: packed.files.map(file => file.path),
}, null, 2) + '\n')
console.log(`Built ${packed.name}@${packed.version}: ${packed.files.length} allowlisted files, ${bytes.length} bytes`)
