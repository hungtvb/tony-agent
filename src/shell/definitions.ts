import { z } from 'zod'
import type { ServiceDefinition, ServiceProvider } from '../seams/types.js'

/**
 * shell service definition — the seam contract for running commands.
 * One provider is active per process: a local provider executes on the host,
 * a future remote/sandbox provider executes elsewhere — consumers unchanged.
 */
export const shellDefinition: ServiceDefinition = {
  id: 'shell',
  schema: z.object({
    kind: z.enum(['local', 'remote']).describe('Provider kind'),
    root: z.string().describe('Working-directory root commands are confined to'),
  }),
}

export interface ShellResult {
  exitCode: number
  stdout: string
  stderr: string
  /** Wall time in ms (0 when the provider cannot measure). */
  durationMs?: number
}

export interface ShellService {
  readonly kind: 'local' | 'remote'
  /** Working-directory root; commands run here (or under a confined subdir). */
  readonly root: string
  /** Run one command with a timeout; rejects on timeout or non-zero exit. */
  run(command: string, options?: { cwd?: string; timeoutMs?: number }): Promise<ShellResult>
}

export type ShellServiceProvider = ServiceProvider<ShellService>