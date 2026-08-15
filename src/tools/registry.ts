import type {
  LLMToolDefinition,
  ToolContext,
  ToolResult,
  TonyTool,
} from '../types.js'

export class ToolRegistry {
  private readonly tools = new Map<string, TonyTool<any>>()

  register<TInput>(tool: TonyTool<TInput>): this {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`)
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool already registered: ${tool.name}`)
    this.tools.set(tool.name, tool as TonyTool<any>)
    return this
  }

  registerMany(tools: TonyTool<any>[]): this {
    for (const tool of tools) this.register(tool)
    return this
  }

  get(name: string): TonyTool<any> | undefined {
    return this.tools.get(name)
  }

  list(): TonyTool<any>[] {
    return Array.from(this.tools.values())
  }

  definitions(): LLMToolDefinition[] {
    return this.list().map((tool) => ({
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
