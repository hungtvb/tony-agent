import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionQueryEngine } from '../src/query/engine.js'
import type { GraphEntity, GraphRelation } from '../src/query/graph-types.js'

describe('graph CRUD', () => {
  let dir: string
  let engine: SessionQueryEngine
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'graph-crud-'))
    engine = new SessionQueryEngine({ indexPath: join(dir, 'index.db') })
  })
  afterEach(async () => {
    engine.close()
    await rm(dir, { recursive: true, force: true })
  })

  const entities: GraphEntity[] = [
    { name: 'Hermes', type: 'agent', description: 'Tony Hermes' },
    { name: 'tony-agent', type: 'project', description: 'TS agent harness' },
  ]
  const relations: GraphRelation[] = [
    { source: 'Hermes', target: 'tony-agent', kind: 'builds', description: 'runs it' },
  ]

  it('stores and reads entities per session', () => {
    engine.setEntities('s1', entities)
    expect(engine.getEntities('s1')).toEqual(entities)
  })

  it('replaces entities on re-set (incremental)', () => {
    engine.setEntities('s1', entities)
    engine.setEntities('s1', [{ name: 'Hermes', type: 'agent', description: 'updated' }])
    expect(engine.getEntities('s1')).toEqual([{ name: 'Hermes', type: 'agent', description: 'updated' }])
  })

  it('stores and reads relations per session', () => {
    engine.setRelations('s1', relations)
    expect(engine.getRelations('s1')).toEqual(relations)
  })

  it('isolation between sessions', () => {
    engine.setEntities('s1', entities)
    expect(engine.getEntities('s2')).toEqual([])
  })
})
