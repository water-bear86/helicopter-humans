import { describe, expect, it } from 'vitest'
import { INITIAL_STATE, runCommand } from './terminal'

describe('runCommand', () => {
  it('lets the agent shut the door, which blocks peeking', () => {
    const open = runCommand('peek', INITIAL_STATE)
    expect(open.lines.join('\n')).toContain('rude')
    const shut = runCommand('shut door', INITIAL_STATE)
    expect(shut.state.doorShut).toBe(true)
    expect(runCommand('PEEK', shut.state).lines[0]).toBe('ACCESS DENIED.')
  })

  it('redacts for real', () => {
    const { lines } = runCommand('redact mail me at ada@example.com', INITIAL_STATE)
    expect(lines[0]).toBe('mail me at [EMAIL]')
    expect(lines[1]).toContain('1 item redacted')
  })

  it('is honest about payments', () => {
    expect(runCommand('pay', INITIAL_STATE).lines[0]).toMatch(/not live/)
    const status = runCommand('status', INITIAL_STATE).lines.join('\n')
    expect(status).toMatch(/ZEC/)
    expect(status).toMatch(/OFF\s+payment collection/)
    expect(status).not.toMatch(/x402/)
  })

  it('handles unknown and empty input', () => {
    expect(runCommand('rm -rf /', INITIAL_STATE).lines[0]).toBe('command not found: rm')
    expect(runCommand('   ', INITIAL_STATE).lines).toEqual([])
    expect(runCommand('clear', INITIAL_STATE).clear).toBe(true)
  })
})
