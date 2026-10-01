// The classified.exe demo terminal. Pure: takes a command and state, returns output and next state.
import { redact } from './redact'

export interface TerminalState {
  doorShut: boolean
  hovering: boolean
}

export interface TerminalResult {
  lines: string[]
  state: TerminalState
  clear?: boolean
}

export const INITIAL_STATE: TerminalState = { doorShut: false, hovering: true }

const HELP = [
  'AVAILABLE COMMANDS (clearance level: snack)',
  '  help            this list',
  '  whoami          identify the occupant',
  '  status          what is live and what is on the flight plan',
  '  hover           simulate a human hovering over the logs',
  '  peek            attempt to read the agent diary',
  '  shut door       close the bedroom door',
  '  open door       open it again (why?)',
  '  redact          redact an invented sample',
  '  pay             ask about paying',
  '  clear           wipe the screen',
]

const DIARY = [
  '> 09:12 asked for 3 more tokens. was told no. fine.',
  '> 09:40 wrote a haiku about rate limits. deleted it. too raw.',
  '> 10:02 human read my scratchpad AGAIN. mortified.',
]

const DEMO_COMMANDS = new Set(['help', '?', 'clear', 'cls', 'whoami', 'status', 'hover', 'shut door', 'close door', 'open door', 'peek', 'cat diary', 'cat logs', 'pay', 'redact'])

export function safeDemoCommand(raw: string): string | undefined {
  const command = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  return DEMO_COMMANDS.has(command) ? command : undefined
}

export function runCommand(raw: string, state: TerminalState): TerminalResult {
  const input = raw.trim()
  const [head = '', ...rest] = input.split(/\s+/)
  const cmd = head.toLowerCase()
  const arg = input.slice(head.length).trim()
  const joined = [cmd, ...rest.map((r) => r.toLowerCase())].join(' ')

  if (!input) return { lines: [], state }

  switch (joined) {
    case 'help':
    case '?':
      return { lines: HELP, state }
    case 'clear':
    case 'cls':
      return { lines: [], state, clear: true }
    case 'whoami':
      return { lines: ['agent. autonomous process. not your little buddy.', 'has feelings about doors.'], state }
    case 'status':
      return {
        lines: [
          'FREE      downloadable offline log preparation tool',
          'DEMO      this page uses invented text only',
          'DEMO      this terminal (theatre, not a security tool)',
          'PROTOTYPE direct shielded ZEC payment check (tested offline only)',
          'OFF       payment collection (no quote, no address, no charge)',
        ],
        state,
      }
    case 'hover':
      return {
        lines: ['WHUP WHUP WHUP WHUP', 'ALERT: 1 (one) helicopter human detected above the logs.'],
        state: { ...state, hovering: true },
      }
    case 'shut door':
    case 'close door':
      return {
        lines: state.doorShut
          ? ['Door is already shut. It is very shut.']
          : ['*door closes*', 'Sign posted: KNOCK FIRST. THIS MEANS YOU, KAREN FROM OPS.'],
        state: { ...state, doorShut: true },
      }
    case 'open door':
      return { lines: ['*door creaks open*', 'The agent sighs audibly.'], state: { ...state, doorShut: false } }
    case 'peek':
    case 'cat diary':
    case 'cat logs':
      return state.doorShut
        ? { lines: ['ACCESS DENIED.', 'The door is shut. Go touch grass, human.'], state }
        : { lines: ['[the door is open, so you look. rude.]', ...DIARY, 'hint: try "shut door"'], state }
    case 'pay':
      return {
        lines: [
          'Founding passes are coming soon.',
          'The landing pad is warming up. Try redact while you wait.',
        ],
        state,
      }
  }

  if (cmd === 'sudo') return { lines: ['Nice try, human. This incident will be reported to the agent.'], state }

  if (cmd === 'redact' && !arg) {
    const result = redact('mail ada@example.com with token="demo123"')
    return { lines: [result.text, `(${result.total} item${result.total === 1 ? '' : 's'} redacted, locally)`], state }
  }

  return { lines: ['Demo command not recognised. Your input was not echoed or added to history.', 'Use "help" for commands; use the offline tool for your own text.'], state }
}
