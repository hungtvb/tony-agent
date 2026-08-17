import { CodeRuntime, CodeRunResult } from './runtime.js'

type NodeWorker = import('node:worker_threads').Worker

let nodeWorker: NodeWorker | null = null

const WORKER_SRC = `
const { parentPort } = require('node:worker_threads')
const { runInNewContext } = require('node:vm')
const { performance } = require('node:perf_hooks')
parentPort.on('message', (msg) => {
  const started = performance.now()
  const out = []
  const err = []
  try {
    const sandbox = {
      console: { log: (...a) => out.push(a.join(' ')), error: (...a) => err.push(a.join(' ')) },
      setTimeout, clearTimeout, Date, Math, JSON, Promise, require,
      process: { env: {} },
    }
    runInNewContext(msg.code, sandbox, { timeout: 30000 })
    parentPort.postMessage({ ok: true, stdout: out.join(String.fromCharCode(10)), stderr: err.join(String.fromCharCode(10)), durationMs: Math.round(performance.now() - started) })
  } catch (e) {
    const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e)
    parentPort.postMessage({ ok: false, stdout: out.join(String.fromCharCode(10)), stderr: err.join(String.fromCharCode(10)), error: message, durationMs: Math.round(performance.now() - started) })
  }
})
`

/**
 * Worker-thread TypeScript runtime. Spawns one reusable worker; each run posts
 * a message, the worker executes the snippet in a `node:vm` sandbox with a
 * captured console and replies with structured stdout/stderr/error. The worker
 * enforces its own timeout (30s).
 */
export function createWorkerThreadRuntime(): CodeRuntime {
  return {
    language: 'typescript',
    async run(request) {
      const started = Date.now()
      const target = await ensureWorker()
      const result = await new Promise<CodeRunResult>((resolve) => {
        let messageHandler: ((data: unknown) => void) | undefined
        const timeout = setTimeout(() => {
          if (messageHandler) target.off('message', messageHandler)
          resolve({ ok: false, stdout: '', stderr: '', error: 'Timed out', durationMs: Date.now() - started })
        }, request.timeoutMs ?? 30_000)
        messageHandler = (data: unknown): void => {
          clearTimeout(timeout)
          target.off('message', messageHandler as (data: unknown) => void)
          const normalized = (data ?? {}) as Partial<CodeRunResult>
          resolve({ ok: false, stdout: '', stderr: '', ...normalized, durationMs: Date.now() - started })
        }
        target.on('message', messageHandler)
        target.postMessage({ code: request.code, cwd: request.cwd })
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