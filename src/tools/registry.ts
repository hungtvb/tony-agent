import type {
  LLMToolDefinition,
  ToolContext,
  ToolPresentation,
  ToolResult,
  TonyTool,
} from '../types.js'

export type RegistryChange =
  | { type: 'registered'; tool: TonyTool<any> }
  | { type: 'unregistered'; name: string }
  | { type: 'replaced'; name: string; tool: TonyTool<any> }

type RegistryListener = (change: RegistryChange) => void

export class ToolRegistry {
  private readonly tools = new Map<string, TonyTool<any>>()
  private readonly listeners = new Set<RegistryListener>()

  register<TInput>(tool: TonyTool<TInput>): this {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`)
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool as TonyTool<any>)
    this.emit({ type: 'registered', tool: tool as TonyTool<any> })
    return this
  }

  registerMany(tools: TonyTool<any>[]): this {
    for (const tool of tools) this.register(tool)
    return this
  }

  /** Remove a tool at runtime. Returns true if it existed. */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name)
    if (removed) this.emit({ type: 'unregistered', name })
    return removed
  }

  /** Hot-swap a tool under the same name (e.g. plugin upgrade). */
  replace<TInput>(tool: TonyTool<TInput>): this {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`)
    }
    this.tools.set(tool.name, tool as TonyTool<any>)
    this.emit({ type: 'replaced', name: tool.name, tool: tool as TonyTool<any> })
    return this
  }

  /** Subscribe to runtime registration changes. Returns an unsubscribe fn. */
  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(change: RegistryChange): void {
    for (const listener of Array.from(this.listeners)) listener(change)
  }

  get(name: string): TonyTool<any> | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  list(): TonyTool<any>[] {
    return Array.from(this.tools.values())
  }

  definitions(options: { presentation?: ToolPresentation } = {}): LLMToolDefinition[] {
    return this.list()
      .filter((tool) => {
        if (!options.presentation) return true
        const mode = tool.presentation ?? 'both'
        return mode === 'both' || mode === options.presentation
      })
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }))
  }

  async execute(name: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) return { content: `Unknown tool: ${name}`, isError: true }
    const parsed = tool.inputSchema.safeParse(input)
    if (!parsed.success) {
      return {
        content: `Invalid arguments for ${name}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
        isError: true,
      }
    }
    try {
      return await tool.execute(parsed.data, context)
    } catch (error) {
      return {
        content: `Tool ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      }
    }
  }
}
