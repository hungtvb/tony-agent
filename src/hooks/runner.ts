import { spawn } from 'node:child_process'
import type { HookOutput, ResolvedHook } from './config.js'
import { defaultHookTimeout } from './config.js'

/** Timeout applied only while the hook is spawned and writing — never leaks into the loop. */
const HOOK_EXEC_MAX_MS = 60_000

/**
 * Runs one hook command: writes the JSON payload to stdin, collects stdout,
 * and maps the exit contract onto a neutral HookOutput.
 *
 * Exit-code contract (Claude Code / Codex pre-tool-use):
 * - exit 0 → allow (unless stdout JSON overrides with a decision)
 * - exit 2 → deny
 * - exit 1  → deny + output as reason (error)
 * - other  → deny (fail-closed, unknown codes treated as deny)
 */
export async function runHookCommand(rule: { command: string; timeout?: number }, payload: ResolvedHook['payload']): Promise<HookOutput> {
  return new Promise<HookOutput>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (output: HookOutput): void => {
      if (settled) return
      settled = true
      resolve(output)
    }

    const timeoutSeconds = rule.timeout ?? defaultHookTimeout()
    const timeoutMs = Math.min(timeoutSeconds * 1000, HOOK_EXEC_MAX_MS)

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(rule.command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      finish({ exitCode: 1, decision: 'deny', reason: `Failed to spawn hook command: ${rule.command}`, output: '' })
      return
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ exitCode: 1, decision: 'deny', reason: `Hook command timed out after ${timeoutSeconds}s: ${rule.command}`, output: stdout, timedOut: true })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('error', (error: Error) => {
      clearTimeout(timer)
      finish({ exitCode: 1, decision: 'deny', reason: `Hook command error: ${error.message}`, output: stdout, stderr })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const exitCode = code ?? (signal ? 1 : 0)
      const output: HookOutput = { exitCode, output: stdout, stderr }
      if (exitCode === 0) {
        output.decision = 'allow'
      } else {
        output.decision = 'deny'
        output.reason = (stdout.trim() || stderr.trim() || `Hook exited with code ${exitCode}`).slice(0, 400)
      }
      finish(output)
    })

    // Write payload as a single JSON line to stdin, then close it.
    // The child may exit before we write (e.g. a fast echo hook) — swallow
    // EPIPE on the stream instead of letting it become an uncaught error.
    child.stdin?.on('error', () => {})
    try {
      child.stdin?.write(JSON.stringify(payload))
      child.stdin?.end()
    } catch {
      // stdin write failures surface via 'error' / 'close' — nothing to do here.
    }
  })
}