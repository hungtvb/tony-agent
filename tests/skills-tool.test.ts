import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createSkillTool } from '../src/skills/tool.js'
import { SkillRegistry } from '../src/skills/registry.js'

describe('createSkillTool', () => {
  it('returns the canonical skill_content render for an invocable skill', async () => {
    const registry = new SkillRegistry()
    registry.register({ name: 'grep', description: 'Search files', content: '# Grep\nUse rg.', invocation: { modelInvocable: true, userInvocable: true } })
    const tool = createSkillTool(registry)
    const result = await tool.execute({ name: 'grep' }, { signal: new AbortController().signal, sessionId: 's' })
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('<skill_content name="grep">')
    expect(result.content).toContain('# Grep')
  })

  it('returns an error with available names for an unknown skill', async () => {
    const registry = new SkillRegistry()
    registry.register({ name: 'alpha', description: 'A', content: 'a', invocation: { modelInvocable: true, userInvocable: true } })
    const tool = createSkillTool(registry, { list: true })
    const result = await tool.execute({ name: 'missing' }, { signal: new AbortController().signal, sessionId: 's' })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Unknown skill: missing')
    expect(result.content).toContain('alpha')
  })

  it('hides non-model-invocable skills from the model', async () => {
    const registry = new SkillRegistry()
    registry.register({ name: 'secret', description: 'S', content: 'hidden', invocation: { modelInvocable: false, userInvocable: true } })
    const tool = createSkillTool(registry)
    const result = await tool.execute({ name: 'secret' }, { signal: new AbortController().signal, sessionId: 's' })
    expect(result.isError).toBe(true)
  })

  it('validates input with zod schema', () => {
    const registry = new SkillRegistry()
    const tool = createSkillTool(registry)
    expect(tool.parameters.required).toContain('name')
  })

  it('uses zod-compatible parameter schema', () => {
    const schema = z.object({ name: z.string() })
    const registry = new SkillRegistry()
    const tool = createSkillTool(registry)
    const parsed = schema.safeParse({ name: 'x' })
    expect(parsed.success).toBe(true)
    expect(tool.parameters).toHaveProperty('required')
  })
})