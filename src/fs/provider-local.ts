import { readFile, readdir, writeFile } from 'node:fs/promises'
import type { PluginContext } from '../plugin/context.js'
import type { FsService, FsServiceProvider } from './definitions.js'
import { fsDefinition } from './definitions.js'
import { resolveSafePath } from '../tools/coding/path-utils.js'

/**
 * Local filesystem provider — serves a workspace root confined by
 * `resolveSafePath` (traversal + symlink-escape rejected). Reads fail closed:
 * missing files throw; write creates parent directories.
 */
export function createLocalFsProvider(options: { root: string }): FsServiceProvider {
  return {
    definition: fsDefinition,
    name: 'local',
    create(_ctx: PluginContext): FsService {
      const root = options.root
      return {
        kind: 'local',
        root,
        resolve: (relative) => resolveSafePath(root, relative),
        read: async (relative) => {
          const target = await resolveSafePath(root, relative)
          return readFile(target, 'utf8')
        },
        write: async (relative, content) => {
          const target = await resolveSafePath(root, relative)
          await writeFile(target, content, 'utf8')
        },
        list: async (relative) => {
          const target = await resolveSafePath(root, relative)
          return readdir(target)
        },
        exists: async (relative) => {
          try {
            await resolveSafePath(root, relative)
            return true
          } catch {
            return false
          }
        },
      }
    },
  }
}
