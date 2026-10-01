import { build } from 'vite'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const result = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'warn',
  build: { write: false, lib: { entry: resolve('src/offline.ts'), formats: ['iife'], name: 'HHOffline' } },
})
const bundle = (Array.isArray(result) ? result : [result]).flatMap(result => result.output).find(item => item.type === 'chunk')
if (!bundle) throw new Error('Offline script missing')
const script = bundle.code.replace(/<\/script/gi, '<\\/script')
const template = await readFile('offline/template.html', 'utf8')
const style = template.match(/<style>([\s\S]*?)<\/style>/)?.[1]
if (!style) throw new Error('Offline styles missing')
const hash = text => `'sha256-${createHash('sha256').update(text).digest('base64')}'`
const csp = `default-src 'none'; connect-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; base-uri 'none'; form-action 'none'`
await writeFile('dist/offline-redactor.html', template.replace('__CSP__', csp).replace('__SCRIPT__', () => script))
console.log('Built self-contained offline-redactor.html (network denied by CSP)')
