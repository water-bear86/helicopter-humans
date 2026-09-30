import { describe, expect, it } from 'vitest'
import { redact } from './redact'

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
    expect(text).toContain('Bearer [BEARER]')
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
})
