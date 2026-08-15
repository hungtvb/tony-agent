import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CredentialStore } from '../src/llm/auth/credential-store.js'
import { resolveApiKey } from '../src/llm/auth/resolve.js'

const directories: string[] = []

async function createStore(): Promise<CredentialStore> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-auth-'))
  directories.push(directory)
  const store = new CredentialStore(directory)
  await store.initialize()
  return store
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('CredentialStore', () => {
  it('sets and gets a provider key', async () => {
    const store = await createStore()
    await store.set('openai', 'sk-test-123')
    expect(await store.get('openai')).toBe('sk-test-123')
  })

  it('deletes a key and returns undefined afterwards', async () => {
    const store = await createStore()
    await store.set('anthropic', 'sk-ant-xyz')
    await store.delete('anthropic')
    expect(await store.get('anthropic')).toBeUndefined()
  })

  it('lists provider names without exposing values', async () => {
      const store = await createStore()
      await store.set('openai', 'value-openai-1')
      await store.set('openrouter', 'value-openrouter-2')
      const list = await store.list()
      expect(list).toEqual(['openai', 'openrouter'])
      const raw = await readFile(join(store.directory, 'credentials.json'), 'utf8')
      expect(raw).not.toContain('value-openai-1')
    })

  it('rejects path traversal provider ids', async () => {
    const store = await createStore()
    await expect(store.set('../evil', 'x')).rejects.toThrow(/invalid/i)
    await expect(store.get('../../etc/passwd')).rejects.toThrow(/invalid/i)
  })
})

describe('resolveApiKey', () => {
  it('prefers explicit value over env and store', async () => {
    const store = await createStore()
    const key = await resolveApiKey({ provider: 'openai', explicit: 'explicit-key', env: 'TEST_OPENAI_KEY', store })
    expect(key).toBe('explicit-key')
  })

  it('falls back to env then store', async () => {
    const store = await createStore()
    process.env.TEST_PI_KEY = 'env-key'
    try {
      expect(await resolveApiKey({ provider: 'openai', env: 'TEST_PI_KEY', store })).toBe('env-key')
      await store.set('openai', 'store-key')
      delete process.env.TEST_PI_KEY
      expect(await resolveApiKey({ provider: 'openai', env: 'TEST_PI_KEY', store })).toBe('store-key')
    } finally {
      delete process.env.TEST_PI_KEY
    }
  })

  it('returns undefined when nothing is configured', async () => {
    const store = await createStore()
    expect(await resolveApiKey({ provider: 'openai', store })).toBeUndefined()
  })
})