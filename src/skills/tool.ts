import type { SkillRegistry } from './registry.js'
import { renderSkillContent, skillToolParameters } from './registry.js'
import type { ToolResult } from '../types.js'

export interface CreateSkillToolOptions {
  /** List available skills. */
  list?: boolean
}

/**
 * Model-facing `skill` tool: loads one skill and returns its canonical
 * `<skill_content>` block. Mirrors the dsh skill-loader tool — the model sees
 * one shape regardless of who initiated the load.
 */
export function createSkillTool(registry: SkillRegistry, options: CreateSkillToolOptions = {}) {
  return {
    name: 'skill',
    description:
      'Load a skill (procedure/guide) by name and return its full instructions. Skills contain reusable workflows, conventions, and pitfalls. Use when a task matches a known skill.',
    risk: 'read' as const,
    inputSchema: null as never, // replaced below via register() override — see ToolRegistry typing
    parameters: skillToolParameters(),
    async execute(input: { name: string }, context: { signal?: AbortSignal; sessionId: string }): Promise<ToolResult> {
      const skill = await registry.getForModel(input.name, { signal: context.signal })
      if (!skill) {
        const summaries = options.list ? await registry.list({ signal: context.signal }) : []
        const available = summaries.length > 0 ? ` Available: ${summaries.map((s) => s.name).join(', ')}` : ''
        return { content: `Unknown skill: ${input.name}.${available}`, isError: true }
      }
      return { content: renderSkillContent(skill) }
    },
  }
}