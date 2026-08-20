import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('REPL UI (terminal surface)', () => {
  const bin = join(process.cwd(), 'dist', 'cli', 'main.js')
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'repl-ui-'))
  })
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  /** Run the CLI under a pseudo-TTY (`script`) and feed stdin lines. */
  function runRepl(input: string, timeoutMs = 15_000): Promise<{ stdout: string; code: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn('script', ['-qec', `node ${bin} --data-dir ${dir}`, '/dev/null'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('REPL test timed out'))
      }, timeoutMs)
      child.stdout.on('data', (d) => (stdout += String(d)))
      child.stderr.on('data', (d) => (stderr += String(d)))
      child.on('close', (code) => {
        clearTimeout(timer)
        // script feeds stdin only after a delay; push input after brief pause
        resolve({ stdout, code })
      })
      // write input line-by-line with small delays so readline sees each
      const lines = input.split('\n')
      let i = 0
      const next = () => {
        if (i >= lines.length) {
          child.stdin.end()
          return
        }
        child.stdin.write(lines[i] + '\n')
        i += 1
        setTimeout(next, 350)
      }
      setTimeout(next, 350)
      void stderr
    })
  }

  it('prints a version banner and a styled prompt', async () => {
    const { stdout } = await runRepl('/help\n/exit\n')
    expect(stdout).toContain('Tony Agent')
    expect(stdout).toContain('v' + pkg.version)
    expect(stdout).toContain('tony ›')
  })

  it('/help shows the command table', async () => {
    const { stdout } = await runRepl('/help\n/exit\n')
    expect(stdout).toContain('REPL commands:')
    expect(stdout).toContain('/history')
    expect(stdout).toContain('/exit')
  })

  it('/history prints a compact transcript, not raw JSON', async () => {
    const { stdout } = await runRepl('/history\n/exit\n')
    expect(stdout).toContain('[system]')
    expect(stdout).not.toContain('"role"')
  })

  it('unknown command shows a friendly error', async () => {
    const { stdout } = await runRepl('/bogus\n/exit\n')
    expect(stdout).toContain('Unknown command')
    expect(stdout).toContain('/bogus')
  })

  it('Ctrl+D (EOF) exits gracefully without an error trailer', async () => {
    const { stdout, code } = await runRepl('') // no input → immediate EOF
    expect(code).not.toBeNull()
    expect(stdout).not.toContain('Error')
  })

  it('/usage shows a friendly message before any run', async () => {
    const { stdout } = await runRepl('/usage\n/exit\n')
    expect(stdout).toContain('No usage recorded yet')
  })

  it('/usage is listed in the help table', async () => {
    const { stdout } = await runRepl('/help\n/exit\n')
    expect(stdout).toContain('/usage')
    expect(stdout).toContain('token usage')
  })

  it('/skills lists loaded skills (or empty message)', async () => {
    const { stdout } = await runRepl('/skills\n/exit\n')
    // data-dir is a temp dir with no skills — either empty message or a list
    expect(stdout).toMatch(/(no skills loaded)|skills:/)
  })

  it('/workspace shows cwd and data-dir', async () => {
    const { stdout } = await runRepl('/workspace\n/exit\n')
    expect(stdout).toContain('workspace:')
    expect(stdout).toContain('cwd:')
    expect(stdout).toContain('data-dir:')
    expect(stdout).toContain('skills:')
  })
})