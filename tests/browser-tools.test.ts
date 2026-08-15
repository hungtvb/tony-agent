import { describe, expect, it } from 'vitest'
import { MemoryPageAdapter } from '../src/host/memory.js'
import { createBrowserTools } from '../src/tools/browser.js'
import { ToolRegistry } from '../src/tools/registry.js'

function context(adapter: MemoryPageAdapter) {
  return {
    signal: new AbortController().signal,
    sessionId: 'session-test',
    adapter,
    metadata: {},
  }
}

describe('createBrowserTools', () => {
  it('registers page reads as low-risk tools and returns host content', async () => {
    const adapter = new MemoryPageAdapter({
      url: 'https://example.test/page',
      title: 'Example Page',
      text: 'Tony Agent reads browser pages.',
    })
    const tools = createBrowserTools()
    const registry = new ToolRegistry().registerMany(tools)

    expect(registry.get('browser_snapshot')?.risk).toBe('read')
    const result = await registry.execute('browser_snapshot', {}, context(adapter))
    expect(result).toMatchObject({ content: expect.stringContaining('Tony Agent reads browser pages.') })
  })

  it('marks page mutation as risky and validates browser tool input', async () => {
    const adapter = new MemoryPageAdapter({
      url: 'https://example.test',
      title: 'Example',
      text: 'Page',
      controls: { '#search': 'Search' },
    })
    const registry = new ToolRegistry().registerMany(createBrowserTools())

    expect(registry.get('browser_click')?.risk).toBe('risky')
    await expect(registry.execute('browser_click', {}, context(adapter))).resolves.toMatchObject({ isError: true })
    await expect(registry.execute('browser_click', { selector: '#search' }, context(adapter))).resolves.toEqual({ content: 'OK' })
  })

  it('keeps arbitrary script execution blocked even when registered', () => {
    const registry = new ToolRegistry().registerMany(createBrowserTools())
    expect(registry.get('browser_execute_script')?.risk).toBe('blocked')
  })
})

// This spec defines the host-independent browser tool contract before implementation.
