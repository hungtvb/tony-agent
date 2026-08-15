import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Model } from '../src/llm/model.js'
import { ModelCatalog, type CatalogEntry } from '../src/llm/model-catalog.js'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-catalog-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function openRouterBodies(): unknown[] {
  return [{
    data: [
      { id: 'openai/gpt-4o-mini', context_length: 128000, max_completion_tokens: 16384, pricing: { prompt: '0.00000015', completion: '0.0000006' } },
      { id: 'anthropic/claude-3.5-sonnet', context_length: 200000, max_completion_tokens: 8192, pricing: { prompt: '0.000003', completion: '0.000015' } },
    ],
  }]
}

describe('ModelCatalog', () => {
  it('discovers models from a provider /models endpoint and caches to disk', async () => {
    const directory = await tempDir()
    const bodies = openRouterBodies()
    const fetcher = (async () => new Response(JSON.stringify(bodies.shift()), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const catalog = new ModelCatalog({ directory, fetcher })
    const entries = await catalog.discover('openrouter', { apiKey: 'k' })

    expect(entries.length).toBeGreaterThanOrEqual(2)
    const gpt = entries.find((entry) => entry.model.id === 'openai/gpt-4o-mini')
    expect(gpt?.model.contextWindow).toBe(128000)
    expect(gpt?.model.cost.input).toBeCloseTo(0.15, 2)
    expect(gpt?.model.api).toBe('openai-completions')

    const cacheRaw = await readFile(join(directory, 'openrouter.models.json'), 'utf8')
    expect(cacheRaw).toContain('openai/gpt-4o-mini')
  })

  it('loads cached models without network when cache is fresh', async () => {
    const directory = await tempDir()
    const fetched: unknown[] = []
    const fetcher = (async () => { fetched.push(1); return new Response('{}', { status: 500 }) }) as typeof fetch
    const catalog = new ModelCatalog({ directory, fetcher })
    const bodies = openRouterBodies()
    // seed cache by discovering once with a working fetcher
    const working = (async () => new Response(JSON.stringify(bodies.shift()), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    await new ModelCatalog({ directory, fetcher: working }).discover('openrouter', { apiKey: 'k' })
    // now read from cache, network fails
    const entries = await catalog.loadCached('openrouter')
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(fetched.length).toBe(0)
  })

  it('returns empty on discovery failure without throwing', async () => {
    const directory = await tempDir()
    const fetcher = (async () => new Response('boom', { status: 500 })) as typeof fetch
    const catalog = new ModelCatalog({ directory, fetcher })
    const entries = await catalog.discover('openrouter', { apiKey: 'k' })
    expect(entries).toEqual([])
  })

  it('maps openrouter ids to providers and attaches cost', async () => {
    const directory = await tempDir()
    const bodies = openRouterBodies()
    const fetcher = (async () => new Response(JSON.stringify(bodies.shift()), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const catalog = new ModelCatalog({ directory, fetcher })
    const entries: CatalogEntry[] = await catalog.discover('openrouter', { apiKey: 'k' })
    const claude = entries.find((entry) => entry.model.id === 'anthropic/claude-3.5-sonnet')
    expect(claude?.model.provider).toBe('anthropic')
    expect(claude?.model.cost.output).toBeCloseTo(15, 2)
  })
})

describe('Model defaults', () => {
  it('exposes a usable model shape', () => {
    const model: Model = { id: 'x', name: 'X', api: 'openai-completions', provider: 'x', baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }
    expect(model.id).toBe('x')
  })
})