import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SAFE_PROVIDER = /^[a-z0-9-]{1,64}$/

interface CredentialFile {
  providers: Record<string, string>
}

/**
 * Provider API-key store persisted as a JSON file (0600) keyed by provider.
 * Real keys are written to disk with restrictive permissions (0o600) so a
 * restart reloads them. The directory itself is created 0o700. The file is
 * written atomically (temp + rename). Listing returns provider names only.
 */
export class CredentialStore {
  readonly directory: string
  private initialized = false
  private keys: Record<string, string> = {}

  constructor(directory: string) {
    this.directory = directory
  }

  private path(): string { return join(this.directory, 'credentials.json') }

  private assertProvider(provider: string): void {
    if (!SAFE_PROVIDER.test(provider)) throw new Error(`Invalid provider id: ${provider}`)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      const raw = await readFile(this.path(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<CredentialFile>
      if (parsed && typeof parsed.providers === 'object' && parsed.providers !== null) {
        for (const provider of Object.keys(parsed.providers)) {
          if (SAFE_PROVIDER.test(provider)) this.keys[provider] = String(parsed.providers[provider])
        }
      }
    } catch {
      // no existing file — start empty
    }
    this.initialized = true
  }

  async get(provider: string): Promise<string | undefined> {
    await this.initialize()
    this.assertProvider(provider)
    const value = this.keys[provider]
    return value === undefined || value === '' ? undefined : value
  }

  async set(provider: string, key: string): Promise<void> {
    await this.initialize()
    this.assertProvider(provider)
    this.keys[provider] = key
    await this.persist()
  }

  async delete(provider: string): Promise<void> {
    await this.initialize()
    this.assertProvider(provider)
    delete this.keys[provider]
    await this.persist()
  }

  async list(): Promise<string[]> {
    await this.initialize()
    return Object.keys(this.keys).sort()
  }

  private async persist(): Promise<void> {
    const snapshot = Object.fromEntries(Object.entries(this.keys).map(([provider, key]) => [provider, key]))
    const temp = `${this.path()}.tmp`
    await writeFile(temp, JSON.stringify({ providers: snapshot }, null, 2), { mode: 0o600 })
    await rename(temp, this.path())
  }
}