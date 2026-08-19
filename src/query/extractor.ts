/**
 * GraphExtractor — LLM entity/relation extraction (LightRAG EXTRACT role).
 *
 * Takes session entries, sends a bounded body to the LLM with a strict-JSON
 * prompt, and returns typed entities/relations. Fail-soft: any LLM or parse
 * error yields empty results + a warning, never a throw (callers decide
 * whether a failed extraction blocks anything — it does not).
 */
import type { LLMCompleter, LLMRequest } from '../types.js'
import type { Entry } from '../harness/session/types.js'
import { bodyFromEntry } from './engine.js'
import type { GraphEntity, GraphRelation } from './graph-types.js'

export interface ExtractionResult {
  entities: GraphEntity[]
  relations: GraphRelation[]
  warnings?: string[]
}

const EXTRACT_PROMPT = `You extract a knowledge graph from conversation entries.
Output STRICT JSON only, no markdown fences, no commentary:
{"entities":[{"name":"...","type":"...","description":"..."}],
 "relations":[{"source":"...","target":"...","kind":"...","description":"..."}]}
- Entity names are exact canonical strings; reuse the same name across entries.
- Relations connect existing entity names only.
- If nothing relevant, output {"entities":[],"relations":[]}.`

/** Max body chars sent per extraction call (bounds cost). */
const MAX_BODY_CHARS = 8000

export class GraphExtractor {
  /**
   * @param llm        LLM completer used for the EXTRACT role.
   * @param modelName  Optional model override (e.g. a fast/cheap model for
   *                   extraction) — forwarded as request.options.model when
   *                   the provider supports it.
   */
  constructor(
    private readonly llm: LLMCompleter,
    private readonly modelName?: string,
  ) {}

  async extract(entries: ReadonlyArray<Entry>): Promise<ExtractionResult> {
    const body = entries.map(bodyFromEntry).join('\n').slice(0, MAX_BODY_CHARS)
    const request: LLMRequest & { options?: { model?: string } } = {
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: body },
      ],
      ...(this.modelName ? { options: { model: this.modelName } } : {}),
    }
    try {
      const response = await this.llm.complete(request)
      return parseExtraction(response.text)
    } catch (error) {
      return { entities: [], relations: [], warnings: [`extraction failed: ${(error as Error).message}`] }
    }
  }
}

/** Parse the LLM's strict-JSON extraction output (fence-tolerant, fail-soft). */
export function parseExtraction(content: string): ExtractionResult {
  try {
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('no JSON object in output')
    const parsed = JSON.parse(content.slice(start, end + 1)) as {
      entities?: Array<{ name: string; type?: string; description?: string }>
      relations?: Array<{ source: string; target: string; kind?: string; description?: string }>
    }
    const entities: GraphEntity[] = (parsed.entities ?? [])
      .filter((e) => typeof e.name === 'string' && e.name.length > 0)
      .map((e) => ({ name: e.name, type: e.type ?? 'entity', ...(e.description ? { description: e.description } : {}) }))
    const relations: GraphRelation[] = (parsed.relations ?? [])
      .filter((r) => typeof r.source === 'string' && typeof r.target === 'string' && r.source.length > 0 && r.target.length > 0)
      .map((r) => ({ source: r.source, target: r.target, kind: r.kind ?? 'related', ...(r.description ? { description: r.description } : {}) }))
    return { entities, relations }
  } catch (error) {
    return { entities: [], relations: [], warnings: [`malformed extraction output: ${(error as Error).message}`] }
  }
}
