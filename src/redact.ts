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
  if (terms.length) {
    // One pass prevents replacements being mistaken for another custom term.
    const pattern = new RegExp(terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g')
    text = text.replace(pattern, () => {
      counts.CUSTOM = (counts.CUSTOM ?? 0) + 1
      return '[CUSTOM]'
    })
  }
  for (const rule of rules) {
    text = text.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      if (rule.accept && !rule.accept(match)) return match
      counts[rule.label] = (counts[rule.label] ?? 0) + 1
      const groups = rest.filter((g): g is string => typeof g === 'string')
      return rule.replace ? rule.replace(match, ...groups) : `[${rule.label}]`
    })
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  return { text, counts, total }
}
