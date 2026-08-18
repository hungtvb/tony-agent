#!/usr/bin/env node
/**
 * e2e smoke — full agent loop with a fake LLM.
 *
 * Runs one complete TonyAgent loop: user prompt → LLM turn 1 (tool call) →
 * tool executes → result feeds back → LLM turn 2 (final answer). Deterministic,
 * offline, fail-fast. Exits 0 on PASS, 1 on any assertion failure.
 *
 *   npx tsx scripts/smoke.ts
 */
import { z } from 'zod'
import { TonyAgent } from '../src/agent.js'
import { PermissionPolicy } from '../src/permissions/policy.js'
import { ToolRegistry } from '../src/tools/registry.js'
import type { LLMCompleter, LLMResult, TonyTool } from '../src/types.js'

/** Minimal echo tool (read risk → auto-allowed). */
const echoTool: TonyTool = {
  name: 'echo',
  description: 'Return the value unchanged',
  risk: 'read',
  inputSchema: z.object({ value: z.string() }),
  parameters: { type: 'object', properties: { value: { type: 'string' } } },
  execute: async (input: { value: string }) => ({ content: `echo:${input.value}` }),
}

/** Scripted LLM: turn 1 requests one tool call, turn 2 answers. */
class SmokeLLM implements LLMCompleter {
  private step = 0
  complete(
    request: { messages: Array<{ role: string; content: string }> },
    callbacks?: { onTextDelta?: (delta: string) => void },
  ): Promise<LLMResult> {
    this.step += 1
    if (this.step === 1) {
      callbacks?.onTextDelta?.('I will echo the value.')
      return Promise.resolve({
        text: 'I will echo the value.',
        toolCalls: [{ id: 'smoke-echo', name: 'echo', arguments: { value: 'smoke-ok' } }],
      })
    }
    callbacks?.onTextDelta?.('SMOKE PASS')
    return Promise.resolve({ text: 'SMOKE PASS', toolCalls: [] })
  }
}

function fail(message: string): never {
  console.error(`\n✗ FAIL: ${message}`)
  process.exit(1)
}

const EVENT_SEQUENCE = [
  'agent_start', 'turn_start', 'message_update', 'tool_call', 'tool_result',
  'turn_end', 'turn_start', 'message_update', 'turn_end', 'agent_end',
]

async function main(): Promise<void> {
  const started = Date.now()
  const llm = new SmokeLLM()
  const events: string[] = []
  const agent = new TonyAgent({
    llm,
    registry: new ToolRegistry().register(echoTool),
    permissions: new PermissionPolicy(),
    onEvent: (event) => events.push(event.type),
  })

  const result = await agent.run('Say smoke-ok')
  const took = Date.now() - started

  // --- assertions ---
  if (result.text !== 'SMOKE PASS') fail(`expected text "SMOKE PASS", got "${result.text}"`)
  if (result.turns !== 2) fail(`expected 2 turns, got ${result.turns}`)
  if (result.toolCalls !== 1) fail(`expected 1 tool call, got ${result.toolCalls}`)
  if (result.events.length !== EVENT_SEQUENCE.length) {
    fail(`expected ${EVENT_SEQUENCE.length} events, got ${result.events.length}: ${events.join(',')}`)
  }
  for (let i = 0; i < EVENT_SEQUENCE.length; i += 1) {
    if (result.events[i]?.type !== EVENT_SEQUENCE[i]) {
      fail(`event[${i}] expected ${EVENT_SEQUENCE[i]}, got ${result.events[i]?.type}`)
    }
  }
  const toolMessage = result.messages.find((m) => m.role === 'tool')
  if (!toolMessage) fail('tool result message missing from agent history')
  if (toolMessage.content !== 'echo:smoke-ok') fail(`tool result content wrong: ${toolMessage.content}`)

  console.log(`\n✓ SMOKE PASS — ${took}ms, ${result.turns} turns, ${result.toolCalls} tool call(s), ${result.events.length} events`)
  console.log(`  events: ${result.events.map((e) => e.type).join(' → ')}`)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))