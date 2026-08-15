import { resolve, sep } from 'node:path'

/**
 * Resolve a path relative to the workspace root and reject any escape
 * (traversal or absolute path outside). Prevents the agent from touching
 * files outside its sandbox.
 */
export function resolveSafePath(workspace: string, input: string): string {
  const root = resolve(workspace)
  const candidate = resolve(root, input)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace: ${input}`)
  }
  return candidate
}