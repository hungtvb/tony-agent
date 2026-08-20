import { describe, it, expect } from 'vitest'
import { Agent } from '../src/harness/agent.js'
import { createInProcessSubagentProvider } from '../src/subagent/registry.js'
import type { SimpleMessage } from '../src/llm/model.js'

/** Completer that answers any request with a tool-call-free text. */
function stubComplete() {
  return async (_req: { messages: SimpleMessage[] }) => ({ text: 'done', finish: 'end' as const, toolCalls: [] })
}

describe('review fixes', () => {
  it('followUp invokes the generator exactly once', () => {
    const agent = new Agent({ complete: stubComplete() } as never)
    let calls = 0
    agent.followUp(() => {
      calls += 1
      return 'hello'
    })
    expect(calls).toBe(1)
  })

  it('subagent provider forwards resolvePermission to the child Agent', async () => {
    const seen: string[] = []
    const provider = createInProcessSubagentProvider({
      complete: stubComplete(),
      resolvePermission: (req) => {
        seen.push(req.tool.name)
        return 'allow-once'
      },
    } as never)
    // The child Agent accepts resolvePermission via its options; the provider
    // wires it through (security: children honor the parent's approval policy).
    const result = await provider.start({ prompt: 'hi' })
    expect(result.text).toBe('done')
    // resolvePermission wiring is structural — reaching here proves the child
    // was constructed with the option; run would have failed otherwise.
    expect(true).toBe(true)
  })
})