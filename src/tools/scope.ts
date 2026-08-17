import type { TonyTool } from '../types.js'

/**
 * Per-agent tool visibility mask (dsh `ctx.tools.restrict(filter)` pattern).
 *
 * A scope layers over the GLOBAL tool map without mutating it:
 * - `allow(name)` — expose a tool that would otherwise be hidden
 * - `deny(name)` — hide a tool from this agent only (shadowing the global)
 * - `shadow(name, tool)` — replace the implementation for this agent only
 *
 * Resolution order (most restrictive wins):
 *   1. explicit deny → hidden
 *   2. explicit allow → visible
 *   3. shadowed name → replaced implementation
 *   4. otherwise → fall back to the global map
 *
 * Shadowed tools keep their original name (callers/tests reference by name),
 * and a denied tool cannot be resurrected by an allow — deny wins, matching
 * the dsh most-restrictive merge (deny > allow).
 */
export class ToolScope {
  private readonly allows = new Set<string>()
  private readonly denies = new Set<string>()
  private readonly shadows = new Map<string, TonyTool<any>>()

  allow(name: string): this {
    this.allows.add(name)
    return this
  }

  deny(name: string): this {
    this.denies.add(name)
    return this
  }

  shadow(name: string, tool: TonyTool<any>): this {
    this.shadows.set(name, tool)
    return this
  }

  has(name: string): boolean {
    if (this.denies.has(name)) return false
    if (this.allows.has(name)) return true
    if (this.shadows.has(name)) return true
    return false
  }

  resolve<T extends TonyTool<any> = TonyTool<any>>(name: string, fallback: (name: string) => T | undefined): T | undefined {
    if (this.denies.has(name)) return undefined
    if (this.shadows.has(name)) return this.shadows.get(name) as T
    if (this.allows.has(name)) return fallback(name)
    return undefined
  }

  /** Apply this scope's restrictions to a list of (name, tool) pairs. */
  filter<T extends TonyTool<any> = TonyTool<any>>(tools: Array<[string, T]>): Array<[string, T]> {
    const result: Array<[string, T]> = []
    for (const [name, tool] of tools) {
      if (this.denies.has(name)) continue
      if (this.shadows.has(name)) {
        result.push([name, this.shadows.get(name) as T])
        continue
      }
      if (this.allows.has(name)) {
        result.push([name, tool])
        continue
      }
    }
    return result
  }
}
