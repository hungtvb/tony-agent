import { resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

/**
 * Resolve a path relative to the workspace root and reject any escape
 * (traversal, absolute path outside, or a symlink that points outside the
 * sandbox). Prevents the agent from touching files outside its workspace,
 * including through symlinks planted inside it.
 *
 * The target may not exist yet (write/edit): we walk up from the candidate to
 * the deepest ancestor that exists, verify that ancestor's real path stays
 * under the workspace root, then re-append the missing tail segments.
 */
export async function resolveSafePath(workspace: string, input: string): Promise<string> {
  const root = resolve(workspace)
  const candidate = resolve(root, input)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new Error(`Path escapes workspace: ${input}`)
  }

  // Walk down-to-up until we find an existing ancestor. If an existing
  // ancestor's real path escapes the root, reject. If nothing from the
  // candidate down to the root exists, the workspace is fresh — accept.
  let probe = candidate
  for (;;) {
    const exists = await existsRealpath(probe)
    if (exists !== null) {
      if (exists !== root && !exists.startsWith(root + sep)) {
        throw new Error(`Path escapes workspace via symlink: ${input}`)
      }
      break
    }
    if (probe === root) break // workspace root doesn't exist yet — nothing to escape
    const parts = probe.split(sep).filter(Boolean)
    const popped = parts.pop()
    if (!popped) break
    probe = parts.length === 0 ? root : `${sep}${parts.join(sep)}`
  }

  // `candidate` is the fully-lexical path and is never mutated; return it as-is
  return candidate
}

/** Returns the realpath if it resolves, or null when the path does not exist. */
async function existsRealpath(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}