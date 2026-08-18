import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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

  it('lists provider names without exposing values in list()', async () => {
      const store = await createStore()
      await store.set('openai', 'value-openai-1')
      await store.set('openrouter', 'value-openai-2')
      expect(await store.list()).toEqual(['openai', 'openrouter'])
    })

  it('persists real keys to disk with 0600 permissions', async () => {
    const store = await createStore()
    await store.set('openai', 'sk-persist-42')
    const raw = await readFile(join(store.directory, 'credentials.json'), 'utf8')
    expect(raw).toContain('sk-persist-42')
    const fileStat = await stat(join(store.directory, 'credentials.json'))
    // 0o600 — owner read/write only
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  it('reloads persisted keys in a new instance (restart survives)', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tony-auth-'))
    directories.push(directory)
    const first = new CredentialStore(directory)
    await first.set('openai', 'sk-restart-99')
    // simulate a process restart: brand-new instance over the same directory
    const second = new CredentialStore(directory)
    await second.initialize()
    expect(await second.get('openai')).toBe('sk-restart-99')
    expect(await second.list()).toEqual(['openai'])
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