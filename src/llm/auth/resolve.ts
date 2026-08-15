import type { CredentialStore } from './credential-store.js'

export interface ResolveOptions {
  provider: string
  explicit?: string
  env?: string
  store?: CredentialStore
}

/** Resolve a provider API key: explicit value → environment → credential store. */
export async function resolveApiKey(options: ResolveOptions): Promise<string | undefined> {
  if (options.explicit) return options.explicit
  if (options.env) {
    const value = process.env[options.env]
    if (value && value.trim().length > 0) return value.trim()
  }
  if (options.store) return options.store.get(options.provider)
  return undefined
}