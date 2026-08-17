import type { JsonSchema } from '../types.js'

/** Invocation policy — which surfaces may invoke this skill. */
export interface SkillInvocationPolicy {
  /** The model may load this skill during a run. */
  modelInvocable: boolean
  /** A user/host may load this skill explicitly. */
  userInvocable: boolean
}

export interface SkillSummary {
  name: string
  description: string
  invocation: SkillInvocationPolicy
}

export interface Skill extends SkillSummary {
  /** Full skill body (markdown / instructions). */
  content: string
  /** Optional trailing resource hints, e.g. `references/…`, `scripts/…`. */
  resourceHints?: string[]
}

export interface SkillLookupOptions {
  /** Workspace/cwd used by filesystem providers to locate skills. */
  cwd?: string
  /** Abort discovery/loading. */
  signal?: AbortSignal
}

export interface SkillProvider {
  readonly name: string
  /** List candidate skills for the current workspace. */
  list(options: SkillLookupOptions): Promise<SkillSummary[]>
  /** Load one skill's full content. */
  get(name: string, options: SkillLookupOptions): Promise<Skill | undefined>
}

export interface SkillProviderFactory {
  (control: { signal: AbortSignal; invalidate: () => void }): SkillProvider
}

export type SkillProviderEntry = {
  provider: SkillProvider
}

const DEFAULT_POLICY: SkillInvocationPolicy = { modelInvocable: true, userInvocable: true }

/**
 * Skill registry with layered providers, mirroring the dsh skill seam:
 * providers register their source (filesystem, runtime, remote); reads merge
 * the global layer; invocation policy separates model-facing vs user-facing
 * surfaces.
 */
export class SkillRegistry {
  private readonly providers = new Map<string, SkillProviderEntry>()
  private readonly runtime: Map<string, Skill> = new Map()

  /** Register a provider factory; returns an unregister disposer. */
  registerProvider(factory: SkillProviderFactory): () => void {
    const control = new AbortController()
    let provider: SkillProvider | undefined
    try {
      provider = factory({ signal: control.signal, invalidate: () => control.abort() })
    } catch (error) {
      control.abort()
      throw error
    }
    if (!provider || !provider.name) throw new Error('Skill provider must have a name')
    if (this.providers.has(provider.name)) {
      control.abort()
      throw new Error(`Skill provider already registered: ${provider.name}`)
    }
    this.providers.set(provider.name, { provider })
    return () => {
      this.providers.delete(provider.name)
      control.abort()
    }
  }

  /** Register an embedded runtime skill (model+user invocable). */
  register(skill: Skill): () => void {
    if (!skill?.name) throw new Error('Runtime skill must have a name')
    if (this.runtime.has(skill.name)) return () => {}
    const full: Skill = {
      ...skill,
      invocation: skill.invocation ?? DEFAULT_POLICY,
      resourceHints: skill.resourceHints ?? [],
    }
    this.runtime.set(skill.name, full)
    return () => this.runtime.delete(skill.name)
  }

  /** List all visible skill summaries, merged across providers, sorted by name. */
  async list(options: SkillLookupOptions = {}): Promise<SkillSummary[]> {
    const byName = new Map<string, SkillSummary>()
    for (const { provider } of Array.from(this.providers.values())) {
      try {
        const summaries = await provider.list(options)
        for (const summary of summaries) {
          if (!byName.has(summary.name)) byName.set(summary.name, summary)
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        // a broken provider must not break discovery for the rest
      }
    }
    for (const skill of Array.from(this.runtime.values())) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill)
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Get one skill (full content) — policy-neutral trusted load. */
  async get(name: string, options: SkillLookupOptions = {}): Promise<Skill | undefined> {
    const runtime = this.runtime.get(name)
    if (runtime) return runtime
    for (const { provider } of Array.from(this.providers.values())) {
      const skill = await provider.get(name, options)
      if (skill) return { ...skill, invocation: skill.invocation ?? DEFAULT_POLICY }
    }
    return undefined
  }

  /** Model-facing gate. */
  async getForModel(name: string, options: SkillLookupOptions = {}): Promise<Skill | undefined> {
    const skill = await this.get(name, options)
    if (!skill?.invocation.modelInvocable) return undefined
    return skill
  }
}

/** Render one skill as the canonical `<skill_content>` block for the model. */
export function renderSkillContent(skill: Skill): string {
  const hints = skill.resourceHints?.length
    ? `\n\nResources:\n${skill.resourceHints.map((hint) => `- ${hint}`).join('\n')}`
    : ''
  const escapedName = skill.name.replace(/"/g, '&quot;')
  return `<skill_content name="${escapedName}">\n${skill.content}\n</skill_content>${hints}`
}

/** Load a skill body from a directory of markdown files (`.md`, frontmatter `name`/`description`). */
export async function loadSkillsFromDirectory(
  dir: string,
  options: { signal?: AbortSignal } = {},
): Promise<Skill[]> {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const skills: Skill[] = []
  for (const entry of entries) {
    options.signal?.throwIfAborted()
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const fullPath = path.join(dir, entry.name)
    const raw = await fs.readFile(fullPath, 'utf8')
    const { name, description } = parseFrontmatter(raw, entry.name.replace(/\.md$/, ''))
    skills.push({
      name,
      description,
      invocation: { modelInvocable: true, userInvocable: true },
      content: raw,
      resourceHints: [],
    })
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name))
}

function parseFrontmatter(raw: string, fallbackName: string): { name: string; description: string } {
  if (!raw.startsWith('---')) return { name: fallbackName, description: '' }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { name: fallbackName, description: '' }
  const frontmatter = raw.slice(3, end)
  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m)
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m)
  return {
    name: nameMatch?.[1]?.trim() ?? fallbackName,
    description: descMatch?.[1]?.trim() ?? '',
  }
}

/** Skill tool input schema (shared by model-facing skill tools). */
export function skillToolParameters(): JsonSchema {
  return {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill name to load' },
    },
    required: ['name'],
    additionalProperties: false,
  }
}