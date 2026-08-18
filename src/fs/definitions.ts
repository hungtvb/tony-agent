import { z } from 'zod'
import type { ServiceDefinition, ServiceProvider } from '../seams/types.js'

/**
 * fs service definition — the seam contract for workspace-confined file
 * access. One provider is active per process; a local provider serves the
 * host filesystem, a future remote provider can serve a sandboxed/remote
 * workspace with zero consumer changes.
 */
export const fsDefinition: ServiceDefinition = {
  id: 'fs',
  schema: z.object({
    kind: z.enum(['local', 'remote']).describe('Provider kind'),
    root: z.string().describe('Workspace root the provider confines to'),
  }),
}

/** File-system capability surface exposed to consumers (model-facing tools). */
export interface FsService {
  readonly kind: 'local' | 'remote'
  /** Absolute workspace root; every operation stays inside it. */
  readonly root: string
  /** Resolve a relative path inside the workspace (rejects escapes). */
  resolve(relative: string): Promise<string>
  read(relative: string): Promise<string>
  write(relative: string, content: string): Promise<void>
  list(relative: string): Promise<string[]>
  exists(relative: string): Promise<boolean>
}

export type FsServiceProvider = ServiceProvider<FsService>
