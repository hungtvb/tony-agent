/**
 * CLI theme — ANSI colors + emoji for a modern agent-harness feel.
 * All helpers no-op when stdout is not a TTY (piped output stays clean).
 */

const COLORS = {
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
} as const

export type ThemeColor = keyof typeof COLORS

function enabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}

/** Wrap text in a color (no-op when not a TTY). */
export function paint(color: ThemeColor, text: string): string {
  if (!enabled()) return text
  return COLORS[color] + text + COLORS.reset
}

export const cyan = (text: string) => paint('cyan', text)
export const green = (text: string) => paint('green', text)
export const yellow = (text: string) => paint('yellow', text)
export const red = (text: string) => paint('red', text)
export const magenta = (text: string) => paint('magenta', text)
export const blue = (text: string) => paint('blue', text)
export const bold = (text: string) => (enabled() ? COLORS.bold + text + COLORS.reset : text)
export const dim = (text: string) => (enabled() ? COLORS.dim + text + COLORS.reset : text)

/** Emoji map — keeps the CLI friendly without depending on Nerd Fonts. */
export const icon = {
  rocket: '🚀',
  check: '✅',
  cross: '❌',
  warn: '⚠️ ',
  spark: '✨',
  gear: '⚙️ ',
  brain: '🧠',
  db: '🗄️ ',
  chat: '💬',
  terminal: '💻',
  tools: '🔧',
  session: '📦',
  lane: '🏷️ ',
  user: '🧑',
  agent: '🤖',
  clock: '⏱️ ',
  link: '🔗',
  list: '📋',
  doc: '📄',
  folder: '📁',
  flag: '🏁',
  fire: '🔥',
} as const

/** Pad a string to a fixed width (strips ANSI codes for measuring). */
export function padEnd(text: string, width: number): string {
  const visible = text.replace(/\x1b\[[0-9;]*m/g, '')
  return text + ' '.repeat(Math.max(0, width - visible.length))
}

/** Render a simple aligned table from rows; first row is a header. */
export function table(headers: string[], rows: Array<Array<string | number>>, options: { widths?: number[] } = {}): string {
  const widths = options.widths ?? headers.map((_, i) => Math.max(...[headers[i]!, ...rows.map((r) => String(r[i] ?? ''))].map((s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length)))
  const line = (cells: Array<string | number>) => '  ' + cells.map((cell, i) => padEnd(String(cell), widths[i]! + 1)).join('').trimEnd()
  const sep = '  ' + widths.map((w) => '─'.repeat(w + 1)).join('').trimEnd()
  const out = [bold(line(headers))]
  out.push(dim(sep))
  for (const row of rows) out.push(line(row))
  return out.join('\n')
}

/** Spinner frames for the agent-loop indicator. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Colorize a status word (ok/fail/warn style). */
export function statusOk(ok: boolean): string {
  return ok ? green('ok') : red('fail')
}