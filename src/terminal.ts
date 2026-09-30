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
  '  status          what is live, what is demo, what is not built',
  '  hover           simulate a human hovering over the logs',
  '  peek            attempt to read the agent diary',
  '  shut door       close the bedroom door',
  '  open door       open it again (why?)',
  '  redact <text>   really redact text, locally, right here',
  '  pay             ask about paying',
  '  clear           wipe the screen',
]

const DIARY = [
  '> 09:12 asked for 3 more tokens. was told no. fine.',
  '> 09:40 wrote a haiku about rate limits. deleted it. too raw.',
  '> 10:02 human read my scratchpad AGAIN. mortified.',
]

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
          'LIVE      log redactor (runs in your browser, sends nothing)',
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
          'Payments are not live on this demo.',
          'No money moves here. See the Pricing section for what is real today.',
        ],
        state,
      }
  }

  if (cmd === 'sudo') return { lines: ['Nice try, human. This incident will be reported to the agent.'], state }

  if (cmd === 'redact') {
    if (!arg) return { lines: ['usage: redact <text>'], state }
    const result = redact(arg)
    return { lines: [result.text, `(${result.total} item${result.total === 1 ? '' : 's'} redacted, locally)`], state }
  }

  return { lines: [`command not found: ${head}`, 'try "help"'], state }
}
