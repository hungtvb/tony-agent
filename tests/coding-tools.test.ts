import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCodingTools } from '../src/tools/coding/index.js'
import { resolveSafePath } from '../src/tools/coding/path-utils.js'

const directories: string[] = []
async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'tony-coding-'))
  directories.push(directory)
  return directory
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('path confinement', () => {
  it('resolves a path inside the workspace', () => {
    const resolved = resolveSafePath('/tmp/w', 'src/app.ts')
    expect(resolved).toBe('/tmp/w/src/app.ts')
  })

  it('rejects traversal outside the workspace', () => {
    expect(() => resolveSafePath('/tmp/w', '../evil.txt')).toThrow()
    expect(() => resolveSafePath('/tmp/w', '/etc/passwd')).toThrow()
  })
})

describe('coding tools', () => {
  it('write tool creates a file and read tool reads it back', async () => {
    const directory = await tempDir()
    const tools = createCodingTools(directory)
    const write = tools.find((tool) => tool.name === 'write')
    const read = tools.find((tool) => tool.name === 'read')
    expect(write).toBeDefined()
    expect(read).toBeDefined()

    const written = await write!.execute({ path: 'hello.txt', content: 'hi there' }, { signal: new AbortController().signal, sessionId: 's', metadata: {} })
    expect(written.content).toContain('Wrote')

    const readResult = await read!.execute({ path: 'hello.txt' }, { signal: new AbortController().signal, sessionId: 's', metadata: {} })
    expect(readResult.content).toContain('hi there')
  })

  it('ls lists files in the workspace', async () => {
    const directory = await tempDir()
    await writeFile(join(directory, 'a.txt'), 'a')
    await writeFile(join(directory, 'b.txt'), 'b')
    const tools = createCodingTools(directory)
    const ls = tools.find((tool) => tool.name === 'ls')!
    const result = await ls.execute({ path: '.' }, { signal: new AbortController().signal, sessionId: 's', metadata: {} })
    expect(result.content).toContain('a.txt')
    expect(result.content).toContain('b.txt')
  })

  it('edit tool applies a diff replacement', async () => {
    const directory = await tempDir()
    await writeFile(join(directory, 'app.ts'), 'const x = 1\n')
    const tools = createCodingTools(directory)
    const edit = tools.find((tool) => tool.name === 'edit')!
    const result = await edit.execute({ path: 'app.ts', oldString: 'const x = 1', newString: 'const y = 2' }, { signal: new AbortController().signal, sessionId: 's', metadata: {} })
    expect(result.content).toContain('Edited')
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(directory, 'app.ts'), 'utf8')).toBe('const y = 2\n')
  })

  it('rejects writes outside the workspace', async () => {
    const directory = await tempDir()
    const tools = createCodingTools(directory)
    const write = tools.find((tool) => tool.name === 'write')!
    const result = await write.execute({ path: '../escape.txt', content: 'x' }, { signal: new AbortController().signal, sessionId: 's', metadata: {} })
    expect(result.isError).toBe(true)
  })

  it('grep finds a pattern in workspace files', async () => {
    const directory = await tempDir()
    await writeFile(join(directory, 'code.ts'), 'export const magic = 42\n')
    const tools = createCodingTools(directory)
    const grep = tools.find((tool) => tool.name === 'grep')!
    const result = await grep.execute({ pattern: 'magic', path: '.' }, { signal: new AbortController().signal, sessionId: 's', metadata: {} })
    expect(result.content).toContain('magic')
  })
})