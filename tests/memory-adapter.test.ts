import { describe, expect, it } from 'vitest'
import { MemoryPageAdapter } from '../src/host/memory.js'

describe('MemoryPageAdapter', () => {
  it('exposes page metadata and readable text in a snapshot', async () => {
    const adapter = new MemoryPageAdapter({
      url: 'https://example.com/docs',
      title: 'Tony Docs',
      text: 'Tony Agent is a browser-native agent runtime.',
      controls: { '#next': 'Next' },
    })

    await expect(adapter.getCurrentUrl()).resolves.toBe('https://example.com/docs')
    await expect(adapter.getPageTitle()).resolves.toBe('Tony Docs')
    await expect(adapter.snapshot()).resolves.toContain('Tony Agent is a browser-native agent runtime.')
  })

  it('executes safe fixture interactions and records state', async () => {
    const adapter = new MemoryPageAdapter({
      url: 'https://example.com',
      title: 'Example',
      text: 'A page',
      controls: { '#search': 'Search' },
    })

    await expect(adapter.click('#search')).resolves.toEqual({ ok: true })
    await expect(adapter.type('#search', 'Tony')).resolves.toEqual({ ok: true })
    await expect(adapter.scroll(400)).resolves.toEqual({ ok: true })
    await expect(adapter.click('#missing')).resolves.toMatchObject({ ok: false })
    await expect(adapter.snapshot()).resolves.toContain('Tony')
  })

  it('supports multiple tabs and active-tab switching', async () => {
    const adapter = new MemoryPageAdapter({ url: 'https://one.test', title: 'One', text: 'First' })
    const second = await adapter.openTab('https://two.test')
    expect(second.active).toBe(true)
    await expect(adapter.listTabs()).resolves.toHaveLength(2)
    await expect(adapter.selectTab('memory-tab-1')).resolves.toBe(true)
    await expect(adapter.getCurrentUrl()).resolves.toBe('https://one.test')
  })
})

// The test is intentionally written before the adapter implementation.
