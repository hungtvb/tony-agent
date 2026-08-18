/**
 * Benchmarks — latency of the core pipelines.
 *
 * Measures wall-clock of:
 *   1. agent loop turn (fake LLM, zero network) — per-turn overhead
 *   2. compaction planning (planCompaction) — 10k synthetic entries
 *   3. session store append (JsonlSessionRepo) — 1k appends
 *   4. memory vector store search — 5k entries
 *
 * Run: `npm run bench`. Results are printed as a small table; no assertions
 * (this is a measurement harness, not a test).
 */
import { performance } from 'node:perf_hooks'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Agent } from '../src/harness/agent.js'
import { planCompaction, formatCompactionSource, createSummaryEntryContent } from '../src/session/compact.js'
import { JsonlSessionRepo } from '../src/harness/session/jsonl/repo.js'
import { createEntry } from '../src/harness/session/types.js'
import { InMemoryVectorStore } from '../src/memory/adapter.js'

interface BenchResult {
  name: string
  iterations: number
  totalMs: number
  perOpMs: number
  opsPerSec: number
}

function fmt(result: BenchResult): string {
  return `${result.name.padEnd(38)} ${String(result.iterations).padStart(8)} iters  ${result.totalMs.toFixed(1).padStart(9)} ms  ${result.perOpMs.toFixed(3).padStart(9)} ms/op  ${result.opsPerSec.toFixed(0).padStart(10)} ops/s`
}

async function benchAgentTurn(): Promise<BenchResult> {
  const iterations = 200
  const started = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    const agent = new Agent({
      complete: async () => ({ text: 'done', toolCalls: [], usage: undefined, stopReason: 'stop' }),
      sessionId: `bench-session-${index}`,
      maxToolCalls: 1,
    })
    await agent.run(`benchmark turn ${index}`)
  }
  const totalMs = performance.now() - started
  return { name: 'agent loop turn (fake LLM)', iterations, totalMs, perOpMs: totalMs / iterations, opsPerSec: (iterations * 1000) / totalMs }
}

async function benchCompaction(): Promise<BenchResult> {
  const iterations = 50
  const estimate = (text: string): number => Math.ceil(text.length / 4)
  const entries = Array.from({ length: 10_000 }, (_, index) => ({
    id: `e${index}`,
    content: `Entry ${index}: some content to estimate tokens for the benchmark suite`,
  }))
  const started = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    const plan = planCompaction(entries, { maxTokens: 500_000, keepRecentTokens: 4_000, estimate })
    if (plan) {
      const source = formatCompactionSource(plan.source)
      const _ = createSummaryEntryContent('summary', [{ id: 'x', content: source.slice(0, 64) }])
    }
  }
  const totalMs = performance.now() - started
  return { name: 'compaction plan (10k entries)', iterations, totalMs, perOpMs: totalMs / iterations, opsPerSec: (iterations * 1000) / totalMs }
}

async function benchSessionAppend(): Promise<BenchResult> {
  const dir = mkdtempSync(join(tmpdir(), 'tony-bench-'))
  const iterations = 1_000
  try {
    const repo = new JsonlSessionRepo(dir)
    const session = await repo.create('bench')
    const started = performance.now()
    for (let index = 0; index < iterations; index += 1) {
      const entry = createEntry({
        kind: 'custom',
        customType: 'bench',
        payload: `benchmark message ${index}`,
        seq: index + 1,
        parentId: index,
      })
      await session.append(entry)
    }
    const totalMs = performance.now() - started
    return { name: 'jsonl session append', iterations, totalMs, perOpMs: totalMs / iterations, opsPerSec: (iterations * 1000) / totalMs }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function benchMemorySearch(): Promise<BenchResult> {
  const iterations = 100
  const store = new InMemoryVectorStore()
  for (let index = 0; index < 5_000; index += 1) {
    await store.add(`memory document ${index} about agent runtimes and tools`, { kind: 'doc', index })
  }
  const started = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    await store.search({ text: 'agent runtime tools', limit: 10 })
  }
  const totalMs = performance.now() - started
  return { name: 'memory search (5k entries)', iterations, totalMs, perOpMs: totalMs / iterations, opsPerSec: (iterations * 1000) / totalMs }
}

async function run(): Promise<void> {
  console.log('tony-agent benchmarks\n')
  const results: BenchResult[] = []
  results.push(await benchAgentTurn())
  results.push(await benchCompaction())
  results.push(await benchSessionAppend())
  results.push(await benchMemorySearch())
  console.log(results.map(fmt).join('\n'))
  console.log('\n(note: deterministic offline harness — no LLM egress involved)')
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})