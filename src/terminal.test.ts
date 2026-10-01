import { describe, expect, it } from 'vitest'
import { INITIAL_STATE, runCommand, safeDemoCommand } from './terminal'

describe('runCommand', () => {
  it('lets the agent shut the door, which blocks peeking', () => {
    const open = runCommand('peek', INITIAL_STATE)
    expect(open.lines.join('\n')).toContain('rude')
    const shut = runCommand('shut door', INITIAL_STATE)
    expect(shut.state.doorShut).toBe(true)
    expect(runCommand('PEEK', shut.state).lines[0]).toBe('ACCESS DENIED.')
  })

  it('demonstrates redaction using only an invented sample', () => {
    const { lines } = runCommand('redact', INITIAL_STATE)
    expect(lines[0]).toBe('mail [EMAIL] with token="[SECRET]"')
    expect(lines[1]).toContain('2 items redacted')
    expect(runCommand('redact private acquisition', INITIAL_STATE).lines.join('\n')).not.toContain('private acquisition')
    expect(safeDemoCommand('redact private acquisition')).toBeUndefined()
  })

  it('keeps payments on the flight plan', () => {
    expect(runCommand('pay', INITIAL_STATE).lines[0]).toMatch(/coming soon/)
    const status = runCommand('status', INITIAL_STATE).lines.join('\n')
    expect(status).toMatch(/ZEC/)
    expect(status).toMatch(/OFF\s+payment collection/)
    expect(status).not.toMatch(/x402/)
  })

  it('handles unknown and empty input', () => {
    expect(runCommand('rm -rf /', INITIAL_STATE).lines[0]).toContain('Demo command not recognised')
    expect(safeDemoCommand('shut door')).toBe('shut door')
    expect(safeDemoCommand('my-secret-password')).toBeUndefined()
    expect(runCommand('   ', INITIAL_STATE).lines).toEqual([])
    expect(runCommand('clear', INITIAL_STATE).clear).toBe(true)
  })
})
