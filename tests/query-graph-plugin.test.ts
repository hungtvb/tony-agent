import { describe, it, expect } from 'vitest'
import { createGraphConsumer, GRAPH_SERVICE_ID, createGraphTools } from '../src/query/plugin.js'
import type { SessionQueryEngine } from '../src/query/engine.js'

describe('query:graph seam', () => {
  it('defines the graph service with read risk', () => {
    const consumer = createGraphConsumer()
    expect(consumer.definition.id).toBe(GRAPH_SERVICE_ID)
    const produced = consumer.uses({} as SessionQueryEngine)
    const tool = Array.isArray(produced) ? produced[0] : produced
    expect(tool.risk).toBe('read')
  })
  it('produces a query:graph tool', () => {
    const consumer = createGraphConsumer()
    const produced = consumer.uses({} as SessionQueryEngine)
    const tool = Array.isArray(produced) ? produced[0] : produced
    expect(tool.name).toBe('query:graph')
    expect(tool.risk).toBe('read')
  })
  it('createGraphTools supports runtime snake_case override', () => {
    const tools = createGraphTools({} as SessionQueryEngine, 'query_graph')
    expect(tools[0]!.name).toBe('query_graph')
  })
})