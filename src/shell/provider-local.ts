import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import type { PluginContext } from '../plugin/context.js'
import type { ShellResult, ShellService, ShellServiceProvider } from './definitions.js'
import { shellDefinition } from './definitions.js'

const execFileAsync = promisify(execFile)

/** Commands allowed by default (allow-list — fail-closed, no deny-list blind spots). */
const DEFAULT_ALLOW = new Set([
  'ls', 'pwd', 'cat', 'echo', 'head', 'tail', 'wc', 'find', 'grep', 'node', 'npm', 'git', 'test', 'true', 'false',
])

/**
 * Local shell provider — allow-listed commands only, run inside a confined
 * working-directory root with a timeout. Any command outside the allow-list
 * (or escaping the root) throws: fail-closed. `execFile` (no shell) avoids
 * shell-injection interpretation of the command line.
 */
export function createLocalShellProvider(options: { root: string; allow?: string[] }): ShellServiceProvider {
  const allowed = new Set(options.allow ?? DEFAULT_ALLOW)
  return {
    definition: shellDefinition,
    name: 'local',
    create(_ctx: PluginContext): ShellService {
      const root = resolve(options.root)
      return {
        kind: 'local',
        root,
        async run(command, runOptions = {}) {
          const [bin, ...args] = command.trim().split(/\s+/)
          if (!bin) throw new Error('Empty command')
          if (!allowed.has(bin)) throw new Error(`Command not allowed: ${bin}`)
          const cwd = resolve(root, runOptions.cwd ?? '.')
          if (cwd !== root && !cwd.startsWith(root + '/')) {
            throw new Error(`cwd escapes shell root: ${runOptions.cwd}`)
          }
          const started = Date.now()
          try {
            const { stdout, stderr } = await execFileAsync(bin, args, {
              cwd,
              timeout: runOptions.timeoutMs ?? 15_000,
              maxBuffer: 1024 * 1024,
              signal: runOptions.signal,
            })
            const result: ShellResult = { exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim(), durationMs: Date.now() - started }
            return result
          } catch (error) {
            const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; killed?: boolean }
            const timedOut = e.killed || e.code === 'ETIMEDOUT'
            throw new Error(
              `Command failed: ${bin} ${args.join(' ')} (${timedOut ? 'timeout' : `exit ${e.code ?? 'unknown'}`})${e.stderr ? `: ${String(e.stderr).slice(0, 200)}` : ''}`,
            )
          }
        },
      }
    },
  }
}