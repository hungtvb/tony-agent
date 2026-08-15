import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FetchLike } from '../types.js'
import type { Model } from './model.js'

export interface CatalogEntry {
  model: Model
  source: 'discovered' | 'cached'
}

export interface CatalogOptions {
  directory: string
  fetcher?: FetchLike
  ttlMs?: number
}

interface OpenRouterModelJson {
  id?: string
  context_length?: number
  max_completion_tokens?: number
  pricing?: { prompt?: string; completion?: string }
}

function numeric(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function providerFromId(id: string): string {
  const prefix = id.split('/')[0] ?? 'unknown'
  return prefix
}

/**
 * Discovers model metadata from a provider's /models endpoint, caches the
 * result as JSON under {directory}/{provider}.models.json, and can reload
 * from cache without network.
 */
export class ModelCatalog {
  readonly directory: string
  private readonly fetcher: FetchLike
  private readonly ttlMs: number

  constructor(options: CatalogOptions) {
    this.directory = options.directory
    this.fetcher = options.fetcher ?? ((input, init) => fetch(input, init))
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000
  }

  private cachePath(provider: string): string {
    return join(this.directory, `${provider}.models.json`)
  }

  async discover(provider: string, options: { apiKey?: string }): Promise<CatalogEntry[]> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`
    const baseUrl = provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1'
    let payload: unknown
    try {
      const response = await this.fetcher(`${baseUrl}/models`, { headers })
      if (!response.ok) return []
      payload = await response.json()
    } catch {
      return []
    }
    const entries = this.parse(payload, provider)
    if (entries.length > 0) await this.writeCache(provider, payload)
    return entries
  }

  async loadCached(provider: string): Promise<CatalogEntry[]> {
    try {
      const stat = await (await import('node:fs/promises')).stat(this.cachePath(provider))
      if (Date.now() - stat.mtimeMs > this.ttlMs) return []
      const raw = await readFile(this.cachePath(provider), 'utf8')
      return this.parse(JSON.parse(raw) as unknown, provider).map((entry) => ({ ...entry, source: 'cached' as const }))
    } catch {
      return []
    }
  }

  private parse(payload: unknown, provider: string): CatalogEntry[] {
    if (!payload || typeof payload !== 'object') return []
    const data = (payload as { data?: unknown[] }).data
    if (!Array.isArray(data)) return []
    const entries: CatalogEntry[] = []
    for (const raw of data) {
      const item = raw as OpenRouterModelJson
      if (typeof item.id !== 'string') continue
      const inputCost = numeric(item.pricing?.prompt) * 1_000_000
      const outputCost = numeric(item.pricing?.completion) * 1_000_000
      entries.push({
        model: {
          id: item.id,
          name: item.id,
          api: 'openai-completions',
          provider: providerFromId(item.id),
          baseUrl: provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : '',
          reasoning: false,
          input: ['text'],
          cost: { input: inputCost, output: outputCost, cacheRead: inputCost / 2, cacheWrite: inputCost * 1.25 },
          contextWindow: item.context_length ?? 0,
          maxTokens: item.max_completion_tokens ?? 0,
        },
        source: 'discovered',
      })
    }
    return entries
  }

  private async writeCache(provider: string, payload: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temp = `${this.cachePath(provider)}.tmp`
    await writeFile(temp, JSON.stringify(payload), 'utf8')
    await rename(temp, this.cachePath(provider))
  }
}