// In-browser redaction for agent logs. Nothing here touches the network.

export interface Rule {
  label: string
  pattern: RegExp
  // Optional check to cut false positives (e.g. Luhn for card numbers).
  accept?: (match: string) => boolean
  // Optional custom replacement; defaults to [LABEL].
  replace?: (match: string, ...groups: string[]) => string
}

export interface RedactionResult {
  text: string
  counts: Record<string, number>
  total: number
}

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 19) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

// Order matters: more specific rules run first so their output is not re-matched.
export const RULES: Rule[] = [
  { label: 'PRIVATE_KEY_BLOCK', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    label: 'API_KEY',
    pattern:
      /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g,
  },
  { label: 'HEADER', pattern: /\b((?:Authorization|Cookie|Set-Cookie)[ \t]*:[ \t]*)[^\r\n]+/gi, replace: (_m, prefix) => `${prefix}[HEADER]` },
  { label: 'BEARER', pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, replace: (_m, prefix) => `${prefix}[BEARER]` },
  { label: 'URL_CREDENTIAL', pattern: /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, replace: (_m, prefix) => `${prefix}[URL_CREDENTIAL]@` },
  {
    label: 'SECRET',
    // Include prefixed names, quoted JSON keys/values, escapes and short credentials.
    pattern: /\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|password|passwd|pwd|auth|cookie)[A-Za-z0-9_-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;}\][&]+)/gi,
    accept: match => !/[:=]\s*["']?\[[A-Z_]+\]["']?$/.test(match),
    replace: (_m, prefix, value) => `${prefix}${value.startsWith('"') ? '"[SECRET]"' : value.startsWith("'") ? "'[SECRET]'" : '[SECRET]'}`,
  },
  { label: 'EVM_PRIVATE_KEY', pattern: /\b0x[a-fA-F0-9]{64}\b/g },
  { label: 'EVM_ADDRESS', pattern: /\b0x[a-fA-F0-9]{40}\b/g },
  { label: 'ZCASH_ADDRESS', pattern: /\b(?:zs1[a-z0-9]{75}|u1[a-z0-9]{100,}|t1[1-9A-HJ-NP-Za-km-z]{33})\b/g },
  { label: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  {
    label: 'CARD',
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: luhn,
  },
  { label: 'IPV4', pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g },
  {
    label: 'HOME_PATH',
    pattern: /(\/(?:Users|home)\/)[^/\s]+/g,
    replace: (_m, prefix) => `${prefix}[USER]`,
  },
  { label: 'WINDOWS_USER', pattern: /([A-Za-z]:\\Users\\)[^\\\s]+/gi, replace: (_m, prefix) => `${prefix}[USER]` },
  // Base58 run typical of Solana/Bitcoin addresses. Runs after hex rules.
  { label: 'BASE58_ADDRESS', pattern: /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g, accept: (m) => /\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) },
]

export function redact(input: string, rules: Rule[] = RULES, literals: string[] = []): RedactionResult {
  const counts: Record<string, number> = {}
  let text = input
  const terms = [...new Set(literals.filter(Boolean))].sort((a, b) => b.length - a.length)
  type Range = [number, number]
  type Edit = { start: number; end: number; replacement: string; delta: number }
  const stages: Edit[][] = []
  const pattern = terms.length ? new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined
  const mapRange = ([from, to]: Range, edits: Edit[]): Range[] => {
    const locate = (position: number, inclusive: boolean) => {
      let low = 0, high = edits.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (edits[middle].end < position || (!inclusive && edits[middle].end === position)) low = middle + 1
        else high = middle
      }
      return low
    }
    const left = locate(from, false), right = locate(to, true)
    const first = edits[left], last = edits[right]
    const tail = edits.at(-1)!
    const after = tail.delta + tail.replacement.length - (tail.end - tail.start)
    if (first && first === last && from >= first.start && to <= first.end) return []
    return [[
      first && from > first.start ? first.start + first.delta : from + (first?.delta ?? after),
      last && to > last.start ? last.start + last.delta + last.replacement.length : to + (last?.delta ?? after),
    ]]
  }
  function* ranges() {
    if (!pattern) return
    for (const match of input.matchAll(pattern)) {
      let mapped: Range[] = [[match.index, match.index + match[0].length]]
      for (const edits of stages) mapped = mapped.flatMap(range => mapRange(range, edits))
      yield* mapped
    }
  }
  const native = (rule: Rule) => RULES.some(known => known.label === rule.label && known.pattern.source === rule.pattern.source && known.pattern.flags === rule.pattern.flags && known.accept === rule.accept && known.replace === rule.replace)
  // A custom callback must not break a native credential prefix while masking its
  // captures. Detect selected native patterns before invoking such callbacks.
  const initial = pattern && rules.some(rule => rule.replace && !native(rule)) ? rules.filter(native) : []
  const ordered = [...initial, ...rules]
  for (const [index, rule] of ordered.entries()) {
    const edits: Edit[] = []
    let delta = 0
    // Optional callbacks may retain or transform captures. Give them masked source.
    const before = text
    const active = pattern && rule.replace && !native(rule) ? [...ranges()] : []
    const maskPart = (value: string, start: number, end: number) => {
      let cursor = start, masked = ''
      for (const [from, to] of active) {
        if (to <= cursor || from >= end) continue
        const begin = Math.max(cursor, from), finish = Math.min(end, to)
        masked += value.slice(cursor - start, begin - start) + '[CUSTOM]'
        cursor = finish
      }
      return masked + value.slice(cursor - start)
    }
    const indexed = active.length ? new RegExp(rule.pattern.source, rule.pattern.flags.replace(/y/g, '') + (rule.pattern.hasIndices ? '' : 'd') + 'y') : undefined
    const maskedInput = active.length ? maskPart(before, 0, before.length) : before
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      if (rule.accept && !rule.accept(match)) return match
      counts[rule.label] = (counts[rule.label] ?? 0) + 1
      const offset = rest.find((value): value is number => typeof value === 'number')!
      let groups = rest.filter((g): g is string => typeof g === 'string')
      let sourceMatch = match
      if (indexed) {
        indexed.lastIndex = offset
        const captures = indexed.exec(before)!
        groups = captures.slice(1).flatMap((value, index) => typeof value === 'string' ? [maskPart(value, ...captures.indices![index + 1]!)] : [])
        groups.push(maskedInput)
        sourceMatch = maskPart(match, offset, offset + match.length)
        const matches = active.filter(([from, to]) => from < offset + match.length && to > offset).length
        if (matches) counts.CUSTOM = (counts.CUSTOM ?? 0) + matches
      }
      const replacement = rule.replace ? rule.replace(sourceMatch, ...groups) : `[${rule.label}]`
      // Keep the ordinary rule pass for values created by optional callbacks,
      // without counting an unchanged native marker a second time.
      if (index >= initial.length && initial.includes(rule) && replacement === match) {
        counts[rule.label]--
        if (!counts[rule.label]) delete counts[rule.label]
      }
      if (terms.length && replacement !== match) {
        // Preserve unchanged edges (e.g. a header/key name or home-path prefix).
        let prefix = 0
        while (prefix < match.length && prefix < replacement.length && match[prefix] === replacement[prefix]) prefix++
        let suffix = 0
        while (suffix < match.length - prefix && suffix < replacement.length - prefix && match[match.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]) suffix++
        edits.push({ start: offset + prefix, end: offset + match.length - suffix, replacement: replacement.slice(prefix, replacement.length - suffix), delta })
        delta += replacement.length - match.length
      }
      return replacement
    })
    if (edits.length) stages.push(edits)
  }
  if (pattern) {
    // Match source text once, so generated markers never become custom matches.
    const mask = () => { counts.CUSTOM = (counts.CUSTOM ?? 0) + 1; return '[CUSTOM]' }
    if (!stages.length) text = text.replace(pattern, mask)
    else {
      const parts: string[] = []
      let cursor = 0, pending: Range | undefined
      const append = ([from, to]: Range) => { parts.push(text.slice(cursor, from), mask()); cursor = to }
      for (const range of ranges()) {
        if (pending && range[0] < pending[1]) pending[1] = Math.max(pending[1], range[1])
        else { if (pending) append(pending); pending = range }
      }
      if (pending) append(pending)
      parts.push(text.slice(cursor))
      text = parts.join('')
    }
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { text, counts, total }
}
