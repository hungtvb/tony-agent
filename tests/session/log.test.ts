import { describe, it, expect } from 'vitest'
import { deriveMessages, assertModelVisibleIsLogged } from '../../src/session/log.js'
import type { SessionEntry } from '../../src/types.js'

function entry(partial: Partial<SessionEntry> & { role: SessionEntry['role'] }): SessionEntry {
  return {
    id: `entry-${Math.random().toString(36).slice(2)}`,
    parentId: undefined,
    content: '',
    createdAt: 0,
    ...partial,
  } as SessionEntry
}

describe('deriveMessages', () => {
  it('projects user/assistant/tool entries in order', () => {
    const entries = [
      entry({ role: 'user', content: 'hi' }),
      entry({ role: 'assistant', content: 'hello', toolCalls: [{ id: 'c1', name: 'ls', arguments: {} }] }),
      entry({ role: 'tool', content: 'res', toolCallId: 'c1', toolName: 'ls' }),
    ]
    const messages = deriveMessages(entries)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[1]?.toolCalls?.[0]?.name).toBe('ls')
    expect(messages[2]?.toolCallId).toBe('c1')
  })

  it('keeps summary as a system message', () => {
    const messages = deriveMessages([entry({ role: 'summary', content: 'sum' })])
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('sum')
  })

  it('drops unknown roles', () => {
    const messages = deriveMessages([entry({ role: 'user', content: 'x' }), entry({ role: 'event' as never, content: 'y' })])
    expect(messages).toHaveLength(1)
  })
})

describe('assertModelVisibleIsLogged', () => {
  it('passes when every request message is in the log', () => {
    const entries = [
      entry({ role: 'user', content: 'hi' }),
      entry({ role: 'assistant', content: 'hello' }),
    ]
    const request = deriveMessages(entries)
    expect(() => assertModelVisibleIsLogged(entries, request)).not.toThrow()
  })

  it('throws when a message is not reconstructable from the log', () => {
    const entries = [entry({ role: 'user', content: 'hi' })]
    const request = [{ role: 'assistant' as const, content: 'ghost' }]
    expect(() => assertModelVisibleIsLogged(entries, request)).toThrow(/not present in session log/)
  })
})