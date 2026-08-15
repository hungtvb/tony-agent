import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSafePath } from '../src/tools/coding/path-utils.js'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'path-esc-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('resolveSafePath symlink escape (review)', () => {
  it('BUG16-REGRESS: throws when a path inside workspace resolves THROUGH a symlink to outside', async () => {
    const dir = await tempDir()
    const outside = await mkdtemp(join(tmpdir(), 'path-esc-out-'))
    dirs.push(outside)
    await writeFile(join(outside, 'secret.txt'), 'classified')
    // workspace/link -> outside (a symlink inside the sandbox pointing out)
    await symlink(outside, join(dir, 'link'))
    // lexical check passes (path starts with root) but real path escapes
    await expect(resolveSafePath(dir, 'link/secret.txt')).rejects.toThrow(/symlink/)
  })

  it('allows legitimate paths inside the workspace', async () => {
    // lexically fine: normal deeper path stays inside
    expect(await resolveSafePath('/tmp/ws', 'a/b/c.txt')).toBe('/tmp/ws/a/b/c.txt')
  })

  it('still rejects plain traversal', async () => {
    await expect(resolveSafePath('/tmp/ws', '../etc/passwd')).rejects.toThrow()
    await expect(resolveSafePath('/tmp/ws', '/etc/passwd')).rejects.toThrow()
  })
})