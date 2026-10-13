import { describe, expect, it } from 'vitest'
import { redact, RULES } from './redact'

describe('redact', () => {
  it('redacts common secrets and identifiers', () => {
    const input = [
      'user=ada@example.com ip=10.0.0.12',
      'OPENAI key sk-proj-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz0123',
      'Authorization: Bearer abc.def.ghijklmnopqrstu',
      'wallet 0x52908400098527886E0F7030069857D2E4169EE7',
      'pk 0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
      'cwd /Users/ada/secret-project',
      'card 4242 4242 4242 4242',
      'sol 79TNuyFNZWhDeFF1RUNA5Xk9Pccvb7xPYqLukBxCeWbb',
    ].join('\n')
    const { text, counts } = redact(input)
    expect(text).not.toContain('ada@example.com')
    expect(text).not.toContain('10.0.0.12')
    expect(text).not.toContain('sk-proj-')
    expect(text).not.toContain('ghp_')
    expect(text).toContain('Authorization: [HEADER]')
    expect(text).toContain('[EVM_ADDRESS]')
    expect(text).toContain('[EVM_PRIVATE_KEY]')
    expect(text).toContain('/Users/[USER]/secret-project')
    expect(text).toContain('[CARD]')
    expect(text).toContain('[BASE58_ADDRESS]')
    expect(counts.EMAIL).toBe(1)
  })

  it('keeps key names for key=value secrets', () => {
    expect(redact('api_key="hunter22222" password: correcthorse').text).toBe(
      'api_key="[SECRET]" password: [SECRET]',
    )
  })

  it('leaves ordinary prose and non-Luhn numbers alone', () => {
    const input = 'The agent closed the door at 12:04 and ordered 1234567890123 snacks.'
    const result = redact(input)
    expect(result.text).toBe(input)
    expect(result.total).toBe(0)
  })

  it('counts every replacement', () => {
    expect(redact('a@b.co c@d.io').total).toBe(2)
  })

  it('masks quoted JSON credentials, short values and prefixed environment keys', () => {
    const input = [String.raw`{"password":"a\"b","access_token":"x","cookie":"session=ab"}`, 'OPENAI_API_KEY=q', 'pwd: 12'].join('\n')
    const result = redact(input)
    expect(result.text).toBe('{"password":"[SECRET]","access_token":"[SECRET]","cookie":"[SECRET]"}\nOPENAI_API_KEY=[SECRET]\npwd: [SECRET]')
    expect(result.total).toBe(5)
  })

  it('removes Basic authentication, cookies and URL userinfo', () => {
    const input = 'Authorization: Basic ZGVtbzpwYXNz\nCookie: session=demo; private=123\nGET https://alice:short@internal.example/path'
    expect(redact(input).text).toBe('Authorization: [HEADER]\nCookie: [HEADER]\nGET https://[URL_CREDENTIAL]@internal.example/path')
  })

  it('masks Windows usernames without dropping useful file context', () => {
    expect(redact('C:\\Users\\Ada\\project\\trace.log').text).toBe('C:\\Users\\[USER]\\project\\trace.log')
  })

  it('supports literal overlapping phrases without treating them as regular expressions', () => {
    const result = redact('Ada Lovelace met Ada at project[a]. Ada Lovelace', undefined, ['Ada', 'Ada Lovelace', 'project[a]', 'CUSTOM'])
    expect(result.text).toBe('[CUSTOM] met [CUSTOM] at [CUSTOM]. [CUSTOM]')
    expect(result.counts.CUSTOM).toBe(4)
  })

  it.each([
    ['sk-proj-abcdefghijklmnop1234', ['proj'], '[API_KEY]', { API_KEY: 1 }],
    ['sk-proj-abcdefghijklmnop1234567890', ['mnop'], '[API_KEY]', { API_KEY: 1 }],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123', ['ghp'], '[API_KEY]', { API_KEY: 1 }],
    ['api_key=synthetic-value', ['api_key'], '[CUSTOM]=[SECRET]', { SECRET: 1, CUSTOM: 1 }],
    ['Authorization: Basic ZGVtbzpwYXNz', ['Authorization'], '[CUSTOM]: [HEADER]', { HEADER: 1, CUSTOM: 1 }],
    ['-----BEGIN PRIVATE KEY-----\nSYNTHETIC_PRIVATE_MATERIAL\n-----END PRIVATE KEY-----', ['PRIVATE KEY'], '[PRIVATE_KEY_BLOCK]', { PRIVATE_KEY_BLOCK: 1 }],
    ['https://alice:synthetic-pass@localhost/', ['https'], '[CUSTOM]://[URL_CREDENTIAL]@localhost/', { URL_CREDENTIAL: 1, CUSTOM: 1 }],
  ])('masks the entire detected credential when a literal overlaps %s', (input, literals, expected, counts) => {
    const result = redact(input, undefined, literals)
    expect(result.text).toBe(expected)
    expect(result.counts).toEqual(counts)
    expect(result.total).toBe(Object.values(counts).reduce((sum, count) => sum + count, 0))
  })

  it('combines overlapping credential ranges without retaining a quoted token body', () => {
    expect(redact('{"token":"sk-proj-abcdefghijklmnop1234"}', undefined, ['token', 'proj']).text).toBe('{"[CUSTOM]":"[API_KEY]"}')
  })

  it('still masks a whole custom phrase spanning an automatic match', () => {
    const result = redact('Private project ada@example.com approved', undefined, ['Private project ada@example.com'])
    expect(result).toEqual({ text: '[CUSTOM] approved', counts: { EMAIL: 1, CUSTOM: 1 }, total: 2 })
  })

  it('merges phrases made to overlap by multiple automatic replacements', () => {
    const result = redact('before a@b.co middle c@d.io after', undefined, ['before a@', 'co middle c@', 'io after'])
    expect(result).toEqual({ text: '[CUSTOM]', counts: { EMAIL: 2, CUSTOM: 1 }, total: 3 })
  })

  it('matches literals only in source text, preserving case, deduplication and generated markers', () => {
    const result = redact('Ada ada Ada sk-proj-abcdefghijklmnop1234 password=q /Users/Ada/project', undefined, ['Ada', 'Ada', '', 'API_KEY', 'SECRET', 'USER'])
    expect(result.text).toBe('[CUSTOM] ada [CUSTOM] [API_KEY] password=[SECRET] /Users/[USER]/project')
    expect(result.counts).toEqual({ CUSTOM: 2, API_KEY: 1, SECRET: 1, HOME_PATH: 1 })
    expect(result.total).toBe(5)
  })

  it('preserves literal-only redaction and rule acceptance checks', () => {
    expect(redact('sk-proj-abcdefghijklmnop1234', [], ['proj']).text).toBe('sk-[CUSTOM]-abcdefghijklmnop1234')
    expect(redact('1234567890123', undefined, ['123']).text).toBe('[CUSTOM]4567890[CUSTOM]')
  })

  it('masks literal source text retained inside an optional replacement callback', () => {
    const result = redact('BEGIN private-project END', [{
      label: 'WRAPPER', pattern: /BEGIN (.*?) END/g, replace: (_match, middle) => `[${middle}]`,
    }], ['private-project'])
    expect(result).toEqual({ text: '[[CUSTOM]]', counts: { WRAPPER: 1, CUSTOM: 1 }, total: 2 })
  })

  it('passes masked captures to optional callbacks that transform or truncate them', () => {
    const rule = { label: 'WRAPPER', pattern: /BEGIN (.*?) END/g, replace: (_match: string, middle: string) => middle.toUpperCase().slice(0, 7) }
    expect(redact('BEGIN private-project END', [rule], ['private-project']).text).toBe('[CUSTOM')
  })

  it('keeps credential coverage when optional callbacks precede cloned native rules', () => {
    const wrapper = { label: 'WRAPPER', pattern: /^(.*)$/g, replace: (_match: string, value: string) => `[${value}]` }
    const rules = [wrapper, ...RULES.map(rule => ({ ...rule, pattern: new RegExp(rule.pattern.source, rule.pattern.flags) }))]
    expect(redact('sk-proj-abcdefghijklmnop1234', rules, ['proj']).text).toBe('[[API_KEY]]')
    expect(redact('/Users/Ada/project', rules, ['Ada']).counts.HOME_PATH).toBe(1)
  })

  it('still applies native rules to credential values created by optional callbacks', () => {
    const rules = [{ label: 'EXPAND', pattern: /invented-key/g, replace: () => 'sk-proj-abcdefghijklmnop1234' }, ...RULES]
    expect(redact('invented-key private-project', rules, ['private-project']).text).toBe('[API_KEY] [CUSTOM]')
  })

  it('leaves unlisted private prose visible rather than calling it protected', () => {
    expect(redact('The confidential acquisition is on Friday.').total).toBe(0)
  })
})
