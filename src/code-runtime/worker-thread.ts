import { CodeRuntime, CodeRunResult, validateCodePolicy } from './runtime.js'

type NodeWorker = import('node:worker_threads').Worker

let nodeWorker: NodeWorker | null = null

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads')
const { runInContext, createContext } = require('node:vm')
const { performance } = require('node:perf_hooks')
parentPort.on('message', (msg) => {
  const started = performance.now()
  const out = []
  const err = []
  try {
    // EMPTY vm context: no require, no process, no host function or host object
    // is exposed. Everything the snippet can reach is a context intrinsic, so
    // there is no .constructor bridge back to the worker's process/require
    // (the classic escape needs a host function value in the sandbox).
    const context = createContext({})
    // Install a console CREATED INSIDE the context: its functions are context
    // intrinsics, and they write into a context-local log array that we pull
    // out after the run. This captures stdout/stderr without leaking any host
    // reference into the sandbox.
    const setup = [
      'const __logs = []',
      'const __log = (ch) => (...args) => { __logs.push([ch, args.map(String).join(" ")]) }',
      'globalThis.console = { log: __log("out"), error: __log("err") }',
    ].join(String.fromCharCode(10))
    runInContext(setup, context, { timeout: msg.timeoutMs ?? 30000 })
    runInContext(msg.code, context, { timeout: msg.timeoutMs ?? 30000 })
    const logs = runInContext('__logs', context, { timeout: 1000 })
    for (const [ch, text] of logs) {
      if (ch === 'out') out.push(text)
      else err.push(text)
    }
    parentPort.postMessage({ ok: true, stdout: out.join(String.fromCharCode(10)), stderr: err.join(String.fromCharCode(10)), durationMs: Math.round(performance.now() - started) })
  } catch (e) {
    const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)
    parentPort.postMessage({ ok: false, stdout: out.join(String.fromCharCode(10)), stderr: err.join(String.fromCharCode(10)), error: message, durationMs: Math.round(performance.now() - started) })
  }
})
`

/**
 * Worker-thread TypeScript runtime. Spawns one reusable worker; each run posts
 * a message, the worker executes the snippet in a hardened `node:vm` context
 * (no require, no process, no host references — see WORKER_SRC) with an
 * in-context console capture and replies with structured stdout/stderr/error.
 * The worker enforces its own timeout (30s default).
 *
 * SECURITY NOTE: the vm context is empty (intrinsics only). `require` and
 * `process` are NOT exposed, so regex-style policy checks are defense-in-depth
 * only — the actual boundary is the context isolation. See tests
 * `code-runtime-escape.test.ts` for the verified escape attempts.
 */
export function createWorkerThreadRuntime(): CodeRuntime {
  return {
    language: 'typescript',
    async run(request) {
      const started = Date.now()
      // abort BEFORE anything reaches the worker
      if (request.signal?.aborted) {
        return { ok: false, stdout: '', stderr: '', error: 'Aborted', durationMs: 0 }
      }
      // policy pre-flight: reject before anything reaches the worker
      const policyIssues = validateCodePolicy(request.code, request.policy)
      if (policyIssues.length > 0) {
        return { ok: false, stdout: '', stderr: '', error: `Blocked by sandbox policy: ${policyIssues.join('; ')}`, durationMs: Date.now() - started }
      }
      const target = await ensureWorker()
      const result = await new Promise<CodeRunResult>((resolve) => {
        let messageHandler: ((data: unknown) => void) | undefined
        const settled = (value: CodeRunResult): void => {
          clearTimeout(timeout)
          if (messageHandler) target.off('message', messageHandler)
          if (request.signal) request.signal.removeEventListener('abort', onAbort)
          resolve(value)
        }
        const timeout = setTimeout(() => {
          settled({ ok: false, stdout: '', stderr: '', error: 'Timed out', durationMs: Date.now() - started })
        }, request.timeoutMs ?? 30_000)
        const onAbort = (): void => {
          settled({ ok: false, stdout: '', stderr: '', error: 'Aborted', durationMs: Date.now() - started })
        }
        messageHandler = (data: unknown): void => {
          const normalized = (data ?? {}) as Partial<CodeRunResult>
          settled({ ok: false, stdout: '', stderr: '', ...normalized, durationMs: Date.now() - started })
        }
        target.on('message', messageHandler)
        request.signal?.addEventListener('abort', onAbort, { once: true })
        target.postMessage({ code: request.code, cwd: request.cwd, timeoutMs: request.timeoutMs })
      })
      return result
    },
  }
}

async function ensureWorker(): Promise<NodeWorker> {
  if (nodeWorker) return nodeWorker
  const { Worker } = await import('node:worker_threads')
  nodeWorker = new Worker(WORKER_SRC, { eval: true })
  return nodeWorker
}