import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const SAFE_PROVIDER = /^[a-z0-9-]{1,64}$/

interface CredentialFile {
  providers: Record<string, string>
}

/**
 * Provider API-key store persisted as a JSON file (0600) keyed by provider.
 * The on-disk file stores a redacted marker per provider; real keys live only
 * in memory for the lifetime of the process, so a leaked file never exposes
 * secrets. Listing returns provider names only.
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
    await mkdir(this.directory, { recursive: true })
    try {
      const raw = await readFile(this.path(), 'utf8')
      const parsed = JSON.parse(raw) as Partial<CredentialFile>
      if (parsed && typeof parsed.providers === 'object' && parsed.providers !== null) {
        for (const provider of Object.keys(parsed.providers)) {
          if (SAFE_PROVIDER.test(provider)) this.keys[provider] = ''
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
    const redacted = Object.fromEntries(Object.keys(this.keys).map((provider) => [provider, '*****']))
    const temp = `${this.path()}.tmp`
    await writeFile(temp, JSON.stringify({ providers: redacted }, null, 2), { mode: 0o600 })
    await rename(temp, this.path())
  }
}