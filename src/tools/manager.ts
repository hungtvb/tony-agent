import type { TonyTool } from '../types.js'

export interface ToolsManagerOptions {
  exclude?: string[]
  allowlist?: string[]
  keepExtensions?: boolean
}

/**
 * Filters the available tool set: allowlist (only these), exclude (remove
 * these), and keepExtensions (extension tools survive even when builtins are
 * excluded). Mirrors the pi coding-agent tools-manager.
 */
export class ToolsManager {
  private readonly tools: Map<string, TonyTool<any>>
  private readonly options: ToolsManagerOptions

  constructor(tools: Map<string, TonyTool<any>>, options: ToolsManagerOptions = {}) {
    this.tools = tools
    this.options = options
  }

  list(): TonyTool<any>[] {
    const { exclude = [], allowlist, keepExtensions = false } = this.options
    const isBuiltin = (name: string): boolean => !name.startsWith('custom_')
    const filtered: TonyTool<any>[] = []
    for (const [name, tool] of Array.from(this.tools)) {
      if (allowlist && !allowlist.includes(name)) continue
      if (exclude.includes(name)) continue
      if (keepExtensions && exclude.length > 0 && isBuiltin(name) && exclude.includes(name)) continue
      filtered.push(tool)
    }
    return filtered
  }

  get(name: string): TonyTool<any> | undefined {
    if (this.options.allowlist && !this.options.allowlist.includes(name)) return undefined
    if (this.options.exclude?.includes(name)) return undefined
    return this.tools.get(name)
  }
}