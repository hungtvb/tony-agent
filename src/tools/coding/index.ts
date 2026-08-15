import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TonyTool } from '../../types.js'
import { resolveSafePath } from './path-utils.js'

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false }
}

const stringProp = (description: string) => ({ type: 'string', description })

/**
 * File/system tools confined to a workspace root (path-utils). Mirrors the
 * pi coding-agent toolset: read/write/edit/ls/grep/find.
 */
export function createCodingTools(workspace: string): TonyTool<any>[] {
  const contextFactory = () => ({ sessionId: 'coding', metadata: {} })

  const write: TonyTool<{ path: string; content: string }> = {
    name: 'write',
    description: 'Write content to a file inside the workspace (creates or overwrites).',
    risk: 'risky',
    inputSchema: undefined as never,
    parameters: schema({ path: stringProp('Relative path inside workspace'), content: stringProp('Full file content') }, ['path', 'content']),
    async execute(input: { path: string; content: string }) {
      try {
        const target = resolveSafePath(workspace, input.path)
        await writeFile(target, input.content, 'utf8')
        return { content: `Wrote ${input.path} (${input.content.length} chars)` }
      } catch (error) {
        return { content: `Error: ${String(error)}`, isError: true }
      }
    },
  }

  const read: TonyTool<{ path: string }> = {
    name: 'read',
    description: 'Read a file inside the workspace.',
    risk: 'read',
    inputSchema: undefined as never,
    parameters: schema({ path: stringProp('Relative path inside workspace') }, ['path']),
    async execute(input: { path: string }) {
      try {
        const target = resolveSafePath(workspace, input.path)
        const content = await readFile(target, 'utf8')
        return { content }
      } catch (error) {
        return { content: `Error: ${String(error)}`, isError: true }
      }
    },
  }

  const edit: TonyTool<{ path: string; oldString: string; newString: string }> = {
    name: 'edit',
    description: 'Replace an exact oldString with newString in a file inside the workspace.',
    risk: 'risky',
    inputSchema: undefined as never,
    parameters: schema({ path: stringProp('Relative path'), oldString: stringProp('Exact text to replace'), newString: stringProp('Replacement text') }, ['path', 'oldString', 'newString']),
    async execute(input: { path: string; oldString: string; newString: string }) {
      try {
        const target = resolveSafePath(workspace, input.path)
        const content = await readFile(target, 'utf8')
        if (!content.includes(input.oldString)) {
          return { content: `Error: oldString not found in ${input.path}`, isError: true }
        }
        const updated = content.split(input.oldString).join(input.newString)
        await writeFile(target, updated, 'utf8')
        return { content: `Edited ${input.path}` }
      } catch (error) {
        return { content: `Error: ${String(error)}`, isError: true }
      }
    },
  }

  const ls: TonyTool<{ path: string }> = {
    name: 'ls',
    description: 'List directory contents inside the workspace.',
    risk: 'read',
    inputSchema: undefined as never,
    parameters: schema({ path: stringProp('Relative path (default .)') }, ['path']),
    async execute(input: { path: string }) {
      try {
        const target = resolveSafePath(workspace, input.path)
        const entries = await readdir(target)
        return { content: entries.join('\n') || '(empty)' }
      } catch (error) {
        return { content: `Error: ${String(error)}`, isError: true }
      }
    },
  }

  const grep: TonyTool<{ pattern: string; path?: string }> = {
    name: 'grep',
    description: 'Find lines matching a pattern in workspace files.',
    risk: 'read',
    inputSchema: undefined as never,
    parameters: schema({ pattern: stringProp('Regex pattern'), path: stringProp('Relative path (default .)') }, ['pattern']),
    async execute(input: { pattern: string; path?: string }) {
      try {
        const target = resolveSafePath(workspace, input.path ?? '.')
        const regex = new RegExp(input.pattern)
        const matches: string[] = []
        await walk(target, async (file) => {
          const content = await readFile(file, 'utf8')
          for (const line of content.split('\n')) {
            if (regex.test(line)) matches.push(`${file}: ${line}`)
          }
        })
        return { content: matches.slice(0, 100).join('\n') || '(no matches)' }
      } catch (error) {
        return { content: `Error: ${String(error)}`, isError: true }
      }
    },
  }

  const find: TonyTool<{ pattern: string; path?: string }> = {
    name: 'find',
    description: 'Find files by name glob inside the workspace.',
    risk: 'read',
    inputSchema: undefined as never,
    parameters: schema({ pattern: stringProp('File name substring'), path: stringProp('Relative path (default .)') }, ['pattern']),
    async execute(input: { pattern: string; path?: string }) {
      try {
        const target = resolveSafePath(workspace, input.path ?? '.')
        const matches: string[] = []
        await walk(target, (file) => {
          if (file.includes(input.pattern)) matches.push(file)
        })
        return { content: matches.slice(0, 100).join('\n') || '(no matches)' }
      } catch (error) {
        return { content: `Error: ${String(error)}`, isError: true }
      }
    },
  }

  void contextFactory
  return [write, read, edit, ls, grep, find]
}

async function walk(root: string, visit: (file: string) => Promise<void> | void): Promise<void> {
  const entries = await readdir(root)
  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue
    const full = join(root, entry)
    const info = await stat(full)
    if (info.isDirectory()) {
      await walk(full, visit)
    } else {
      await visit(full)
    }
  }
}