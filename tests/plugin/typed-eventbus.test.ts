import { describe, expect, it } from 'vitest'
import { EventBus } from '../../src/plugin/events.js'

// Extend the default EventMap with concrete payloads so emit<K> is checked.
declare module '../../src/plugin/events.js' {
  interface EventMap {
    'user:greet': { name: string }
    'agent:done': { sessionId: string; turns: number }
  }
}

describe('typed EventBus', () => {
  it('emits typed events with correct payloads', () => {
    const bus = new EventBus()
    const seen: string[] = []
    bus.on('user:greet', (event) => {
      // payload is typed: event.name is string
      seen.push(event.name)
    })
    bus.on('agent:done', (event) => {
      seen.push(`${event.sessionId}:${event.turns}`)
    })
    bus.emit('user:greet', { name: 'Tony' })
    bus.emit('agent:done', { sessionId: 's1', turns: 3 })
    expect(seen).toEqual(['Tony', 's1:3'])
  })

  it('rejects unknown event names at compile time (ts-expect-error)', () => {
    const bus = new EventBus()
    // @ts-expect-error — 'nonexistent' is not a key of EventMap
    bus.emit('nonexistent', {})
    // @ts-expect-error — payload type mismatch
    bus.emit('user:greet', { wrong: true })
    expect(bus).toBeDefined()
  })

  it('stays backward-compatible with the default event map', () => {
    const bus = new EventBus()
    bus.emit({ type: 'turn_start', sessionId: 's', turn: 1 })
    bus.emit({ type: 'custom-x', anything: 42 })
    expect(bus).toBeDefined()
  })

  it('on() with no type annotation still works (default listener)', () => {
    const bus = new EventBus()
    const events: string[] = []
    bus.on((event) => events.push(String((event as { type?: string }).type)))
    bus.emit({ type: 'anything' })
    expect(events).toEqual(['anything'])
  })
})