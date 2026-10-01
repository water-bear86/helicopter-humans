// SPDX-License-Identifier: MIT
// Ported from the project's inert, bounded Python marker scanner.
const definitions = {
  'x402-challenge-marker': /(?<![A-Za-z0-9_-])(?:PAYMENT-REQUIRED|X-PAYMENT-REQUIRED)(?![A-Za-z0-9_-])/gi,
  'x402-authorization-marker': /(?<![A-Za-z0-9_-])(?:PAYMENT-SIGNATURE|X-PAYMENT)(?![A-Za-z0-9_-])/gi,
  'x402-settlement-marker': /(?<![A-Za-z0-9_-])(?:PAYMENT-RESPONSE|X-PAYMENT-RESPONSE)(?![A-Za-z0-9_-])/gi,
  'x402-versioned-message': /(?<![A-Za-z0-9_])x402Version(?![A-Za-z0-9_])/gi,
  'payment-receipt-marker': /(?<![A-Za-z0-9_])(?:payment[_-]?(?:receipt|hash|transaction)|invoice[_-]?id)(?![A-Za-z0-9_])/gi,
  'github-token': /(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})/g,
  'secret-key-shaped': /sk-(?:proj-)?[A-Za-z0-9_-]{20,255}/g,
  'aws-access-key-id': /(?:AKIA|ASIA)[A-Z0-9]{16}/g,
  'private-key-marker': /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  'bearer-token-shaped': /Bearer[ \t]+[A-Za-z0-9._~+/=-]{12,512}/gi,
  'credential-assignment': /(?:api[_-]?key|password|client[_-]?secret|access[_-]?token)["']?[ \t]*[:=][ \t]*["']?[^\s"',;}]{8,256}/gi,
}

export function msgpackTexts(data) {
  const texts = []
  let nodes = 0
  function walk(pos, depth) {
    if (++nodes > 100_000 || depth > 64 || pos >= data.length) throw new Error('bounds')
    const tag = data[pos++]
    const take = size => {
      const end = pos + size
      if (end > data.length) throw new Error('bounds')
      const value = data.subarray(pos, end)
      pos = end
      return value
    }
    if (tag <= 0x7f || tag >= 0xe0 || [0xc0, 0xc2, 0xc3].includes(tag)) return pos
    if (tag >= 0xa0 && tag <= 0xbf) { texts.push(take(tag & 31)); return pos }
    let count
    if (tag >= 0x80 && tag <= 0x9f) count = (tag & 15) * (tag < 0x90 ? 2 : 1)
    else if ([0xdc, 0xdd, 0xde, 0xdf].includes(tag)) {
      const size = [0xdc, 0xde].includes(tag) ? 2 : 4
      count = take(size).readUIntBE(0, size) * ([0xde, 0xdf].includes(tag) ? 2 : 1)
    } else if ([0xc4, 0xc5, 0xc6, 0xd9, 0xda, 0xdb, 0xc7, 0xc8, 0xc9].includes(tag)) {
      const sizes = { 0xc4: 1, 0xc5: 2, 0xc6: 4, 0xd9: 1, 0xda: 2, 0xdb: 4, 0xc7: 1, 0xc8: 2, 0xc9: 4 }
      const size = take(sizes[tag]).readUIntBE(0, sizes[tag])
      if ([0xc7, 0xc8, 0xc9].includes(tag)) take(1)
      texts.push(take(size))
      return pos
    } else {
      const sizes = { 0xca: 4, 0xcb: 8, 0xcc: 1, 0xcd: 2, 0xce: 4, 0xcf: 8, 0xd0: 1, 0xd1: 2, 0xd2: 4, 0xd3: 8, 0xd4: 2, 0xd5: 3, 0xd6: 5, 0xd7: 9, 0xd8: 17 }
      if (!sizes[tag]) throw new Error('tag')
      const value = take(sizes[tag])
      if (tag >= 0xd4 && tag <= 0xd8) texts.push(value.subarray(1))
      return pos
    }
    if (count > 100_000) throw new Error('bounds')
    for (let i = 0; i < count; i++) pos = walk(pos, depth + 1)
    return pos
  }
  try { return walk(0, 0) === data.length ? texts : [] } catch { return [] }
}

function count(text, pattern) {
  pattern.lastIndex = 0
  let found = 0
  while (pattern.exec(text)) found++
  return found
}
const receiptFields = text => ['transaction', 'network', 'payer'].every(field => new RegExp(`(?<![A-Za-z0-9_])${field}(?![A-Za-z0-9_])`, 'i').test(text))

export function candidates(data) {
  const raw = Buffer.from(data).toString('latin1')
  const scalars = msgpackTexts(Buffer.from(data)).map(text => text.toString('latin1'))
  const found = {}
  for (const [name, pattern] of Object.entries(definitions)) {
    const n = Math.max(count(raw, pattern), scalars.reduce((n, text) => n + count(text, pattern), 0))
    if (n) found[name] = n
  }
  if (receiptFields(raw)) found['settlement-fields-candidate'] = 1
  const seen = new Set()
  let examined = 0, decodedBytes = 0
  outer: for (const text of [raw, ...scalars]) {
    for (const match of text.matchAll(/(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/-]{24,65536}={0,2}(?![A-Za-z0-9_+/=-])/g)) {
      if (examined++ >= 256 || decodedBytes >= 1024 * 1024) break outer
      const token = match[0]
      if (seen.has(token)) continue
      seen.add(token)
      const normalized = token.replaceAll('-', '+').replaceAll('_', '/')
      if (normalized.length % 4 === 1) continue
      const decoded = Buffer.from(normalized, 'base64')
      if (decoded.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) continue
      decodedBytes += decoded.length
      const value = decoded.toString('latin1')
      for (const [name, pattern] of Object.entries(definitions)) {
        if (!name.startsWith('x402-')) continue
        const n = count(value, pattern)
        if (n) found[`base64-${name}`] = (found[`base64-${name}`] ?? 0) + n
      }
      if (receiptFields(value)) found['base64-settlement-fields-candidate'] = (found['base64-settlement-fields-candidate'] ?? 0) + 1
    }
  }
  return found
}
