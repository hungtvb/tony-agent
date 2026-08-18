import { describe, expect, it, vi } from 'vitest'
import {
  SkillRegistry,
  loadSkillsFromDirectory,
  renderSkillContent,
  type SkillProvider,
} from '../src/skills/registry.js'

function memoryProvider(skills: Array<{ name: string; description: string; content: string }>): SkillProvider {
  return {
    name: 'memory',
    async list() {
      return skills.map((skill) => ({ name: skill.name, description: skill.description, invocation: { modelInvocable: true, userInvocable: true } }))
    },
    async get(name) {
      const skill = skills.find((candidate) => candidate.name === name)
      return skill
        ? { ...skill, invocation: { modelInvocable: true, userInvocable: true }, resourceHints: [] }
        : undefined
    },
  }
}

describe('SkillRegistry', () => {
  it('registers providers and lists merged summaries sorted by name', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(() => memoryProvider([
      { name: 'zeta-skill', description: 'last', content: '# Zeta' },
      { name: 'alpha-skill', description: 'first', content: '# Alpha' },
    ]))
    registry.register({ name: 'runtime-skill', description: 'embedded', content: '# Runtime', invocation: { modelInvocable: true, userInvocable: true } })

    const summaries = await registry.list()
    expect(summaries.map((s) => s.name)).toEqual(['alpha-skill', 'runtime-skill', 'zeta-skill'])
  })

  it('dedupes by name with first provider winning', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(() => memoryProvider([{ name: 'dup', description: 'from provider', content: 'body' }]))
    registry.register({ name: 'dup', description: 'from runtime', content: 'other', invocation: { modelInvocable: true, userInvocable: true } })

    const summaries = await registry.list()
    expect(summaries.filter((s) => s.name === 'dup')).toHaveLength(1)
  })

  it('rejects duplicate provider names and invalid providers', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(() => memoryProvider([]))
    expect(() => registry.registerProvider(() => memoryProvider([]))).toThrow(/already registered/)
    expect(() => registry.registerProvider(() => ({ name: '', list: async () => [], get: async () => undefined }))).toThrow(/must have a name/)
  })

  it('unregister disposers remove providers and runtime skills', async () => {
    const registry = new SkillRegistry()
    const removeProvider = registry.registerProvider(() => memoryProvider([{ name: 'gone', description: '', content: 'x' }]))
    const removeSkill = registry.register({ name: 'gone-too', description: '', content: 'y', invocation: { modelInvocable: true, userInvocable: true } })
    expect(await registry.list()).toHaveLength(2)
    removeProvider()
    removeSkill()
    expect(await registry.list()).toHaveLength(0)
  })

  it('get returns full skill and honors model invocation policy', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(() => memoryProvider([{ name: 'model-only', description: 'm', content: 'body' }]))
    const modelOnly = {
      name: 'model-only-2',
      description: 'hidden from model',
      content: 'x',
      invocation: { modelInvocable: false, userInvocable: true },
    }
    registry.register(modelOnly)

    const loaded = await registry.get('model-only')
    expect(loaded?.content).toBe('body')
    expect(await registry.getForModel('model-only-2')).toBeUndefined()
    expect(await registry.getForModel('model-only')).toBeDefined()
  })

  it('provider list failures do not break other providers', async () => {
    const registry = new SkillRegistry()
    registry.registerProvider(() => ({
      name: 'broken',
      async list() { throw new Error('boom') },
      async get() { throw new Error('boom') },
    }))
    registry.registerProvider(() => memoryProvider([{ name: 'ok', description: '', content: 'fine' }]))
    registry.register({ name: 'rt', description: '', content: 'rt', invocation: { modelInvocable: true, userInvocable: true } })
    const summaries = await registry.list()
    expect(summaries.map((s) => s.name)).toEqual(['ok', 'rt'])
  })
})

describe('renderSkillContent', () => {
  it('renders canonical skill_content block with escaped name and resource hints', () => {
    const skill = {
      name: 'skill "quoted"',
      description: 'd',
      invocation: { modelInvocable: true, userInvocable: true } as const,
      content: 'line1\nline2',
      resourceHints: ['references/api.md', 'scripts/run.sh'],
    }
    const rendered = renderSkillContent(skill)
    expect(rendered).toContain('<skill_content name="skill &quot;quoted&quot;">')
    expect(rendered).toContain('line1\nline2')
    expect(rendered).toContain('Resources:')
    expect(rendered).toContain('- scripts/run.sh')
  })
})

describe('loadSkillsFromDirectory', () => {
  it('loads markdown skills with frontmatter and fallback names', async () => {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ta-skills-'))
    await fs.writeFile(path.join(dir, 'grep.md'), '---\nname: grep-files\n---\n# Grep files\n...')
    await fs.writeFile(path.join(dir, 'notes.md'), 'plain markdown, no frontmatter')
    try {
      const skills = await loadSkillsFromDirectory(dir)
      expect(skills).toHaveLength(2)
      const grep = skills.find((s) => s.name === 'grep-files')
      expect(grep?.description).toBe('')
      expect(grep?.content).toContain('# Grep files')
      expect(skills.find((s) => s.name === 'notes')).toBeDefined()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('SkillRegistry cancellation', () => {
  it('passes abort signal through lookup options', async () => {
    const registry = new SkillRegistry()
    const spy = vi.fn()
    registry.registerProvider(({ signal }) => ({
      name: 'slow',
      async list(options) {
        options.signal?.throwIfAborted()
        spy()
        return []
      },
      async get() { return undefined },
    }))
    const controller = new AbortController()
    controller.abort()
    await expect(registry.list({ signal: controller.signal })).rejects.toThrow('aborted')
    expect(spy).not.toHaveBeenCalled()
  })
})
describe('DirectorySkillProvider', () => {
  it('discovers *.md skills with frontmatter and loads content', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'tony-skills-'))
    try {
      await writeFile(join(dir, 'alpha.md'), '---\nname: alpha-skill\ndescription: First skill\n---\n# Alpha body')
      await writeFile(join(dir, 'beta.md'), 'no frontmatter here')
      await writeFile(join(dir, 'notes.txt'), 'ignored')

      const provider = new (await import('../src/skills/registry.js')).DirectorySkillProvider(dir)
      const summaries = await provider.list()
      expect(summaries.map((s) => s.name)).toEqual(['alpha-skill', 'beta'])
      expect(summaries.find((s) => s.name === 'alpha-skill')?.description).toBe('First skill')

      const alpha = await provider.get('alpha-skill')
      expect(alpha?.content).toContain('# Alpha body')
      expect(alpha?.invocation.modelInvocable).toBe(true)
      expect(await provider.get('missing')).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('works through SkillRegistry provider layer', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'tony-skills-reg-'))
    try {
      await writeFile(join(dir, 'alpha.md'), '---\nname: alpha-skill\ndescription: First\n---\nBody')
      const registry = new SkillRegistry()
      const { DirectorySkillProvider } = await import('../src/skills/registry.js')
      registry.registerProvider(() => new DirectorySkillProvider(dir, 'disk'))
      const names = (await registry.list()).map((s) => s.name)
      expect(names).toContain('alpha-skill')
      const loaded = await registry.getForModel('alpha-skill')
      expect(loaded?.content).toContain('Body')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
