export type CliCommand =
  | 'run' | 'prompt' | 'new' | 'steer' | 'abort' | 'fork' | 'compact' | 'export'
  | 'switch' | 'list' | 'get' | 'clone' | 'set' | 'cycle' | 'server' | 'client' | 'models' | 'doctor'

export interface ParsedCli {
  command: CliCommand
  target?: string
  prompt?: string
  session?: string
  offline: boolean
  nonInteractive: boolean
  json: boolean
  dataDir?: string
}

const POSITIONAL_COMMANDS = new Set<CliCommand>(['new', 'fork', 'switch', 'get', 'clone', 'set', 'cycle', 'prompt'])

/** Parse pi-parity CLI argv into a structured command. */
export function parseCliArgs(argv: string[]): ParsedCli {
  const parsed: ParsedCli = {
    command: 'run',
    offline: false,
    nonInteractive: false,
    json: false,
  }
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = argv[index + 1]
    if (POSITIONAL_COMMANDS.has(arg as CliCommand) && !arg.startsWith('-')) {
      parsed.command = arg as CliCommand
    } else if (arg === 'run' || arg === 'server' || arg === 'client' || arg === 'models' || arg === 'abort' || arg === 'compact' || arg === 'export' || arg === 'doctor' || arg === 'list' || arg === 'steer') {
      parsed.command = arg as CliCommand
    } else if (arg === '-s' || arg === '--session') { if (value) { parsed.session = value; index += 1 } }
    else if (arg === '--offline') parsed.offline = true
    else if (arg === '--non-interactive' || arg === '-y' || arg === '--yes') parsed.nonInteractive = true
    else if (arg === '--json') parsed.json = true
    else if (arg === '--data-dir' && value) { parsed.dataDir = value; index += 1 }
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  if (parsed.command === 'new' || parsed.command === 'fork' || parsed.command === 'switch' || parsed.command === 'get' || parsed.command === 'clone' || parsed.command === 'set' || parsed.command === 'cycle') {
    parsed.target = positional[0]
  }
  if (parsed.command === 'prompt' || parsed.command === 'steer' || parsed.command === 'set') {
    parsed.prompt = positional.join(' ')
  }
  return parsed
}