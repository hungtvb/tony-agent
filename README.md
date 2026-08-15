# Tony Agent

Self-built, browser-native AI agent runtime. No agent harness dependency — the agent loop, LLM transport, tool system, permission policy, durable sessions, and remote protocol are all implemented in this repository. v0.2.0 reaches pi-agent breadth across the LLM layer, stateful agent harness, session backends, coding tools, and CLI.

- **Unified LLM layer** — `Models`/`Api` abstraction with provider adapters (OpenAI-compatible, Anthropic, OpenRouter, Vercel gateway), model discovery, and a credential store that keeps secret values memory-only (redacted on disk).
- **Agent loop** — bounded LLM → tool → result loop with streaming deltas, per-turn and per-run limits, loop detection, abort, and event stream.
- **Stateful harness** — `Agent` class with hooks (`beforeToolCall`/`afterToolCall`/`transformContext`), steering/follow-up queues, sequential + parallel tool batches, loop guards.
- **Durable sessions** — entry model with lanes; JSONL repo (atomic writes, branching, corruption-tolerant) and SQLite backend; compaction + branch summarization; `AgentHarness` with crash recovery.
- **Tools** — typed registry with Zod input validation; 27 built-in browser tools across read/light/risky/blocked risk levels; coding toolset (write/read/edit/ls/grep/find) confined to a workspace root.
- **Permissions** — per-tool/site policy: `allow` / `confirm` / `deny`, allow-once vs allow-session, fail-closed.
- **Remote protocol** — framed CBOR (4-byte length + CBOR body) with `TonyServer`/`TonyClient` for remote sessions.
- **Hosts** — Electron-free core; `PageAdapter` interface plus a working CDP adapter for Chromium/Electron targets.

## Install

```bash
npm install
npm run build
```

Node.js >= 20.

## CLI

```bash
# One-shot prompt against a provider
TONY_LLM_URL=https://api.openai.com/v1 \
TONY_LLM_MODEL=gpt-4o-mini \
OPENAI_API_KEY=... \
npm run cli -- run -p "Summarize the current page"

# Deterministic offline fixture (no provider needed)
npm run cli -- run --offline -p "Summarize this page"

# Interactive session
npm run cli -- run

# Validate provider connectivity
npm run cli -- doctor

# Machine-readable output
npm run cli -- run --offline -p "hi" --json

# Pi-parity session commands
npm run cli -- new my-session
npm run cli -- list --json
npm run cli -- prompt "write a readme" -s <session-id>
npm run cli -- steer -s <session-id> "more detail please"
npm run cli -- fork <branch-name> -s <session-id>
npm run cli -- compact -s <session-id>
npm run cli -- export -s <session-id>
```

Flags: `-p/--prompt`, `-s/--session`, `--data-dir`, `--base-url`, `--api-key`, `--model`, `--max-turns`, `--non-interactive`, `--offline`, `--no-stream`, `--json`.

Commands: `run`, `prompt`, `new`, `steer`, `abort`, `fork`, `compact`, `export`, `switch`, `list`, `get`, `clone`, `set`, `cycle`, `server`, `client`, `models`, `doctor`.

Environment: `TONY_LLM_URL`, `TONY_LLM_MODEL`, `TONY_LLM_KEY`, `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `TONY_AGENT_DATA_DIR`.

## Library usage

```ts
import { TonyRuntime, SessionStore, ToolRegistry, PermissionPolicy, createBrowserTools, TonyLLMClient } from 'tony-agent'

const store = new SessionStore('./sessions')
await store.initialize()

const runtime = new TonyRuntime({
  store,
  llm: new TonyLLMClient({ baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' }),
  registry: new ToolRegistry().registerMany(createBrowserTools()),
  permissions: new PermissionPolicy(),
  adapter: new CdpBrowserAdapter({ endpoint: 'http://127.0.0.1:9222' }),
  resolvePermission: (request) => (process.env.CI ? 'deny' : 'allow-once'),
})

const session = await runtime.createSession('Research')
const result = await session.ask('Summarize the active tab')
console.log(result.text)
```

## Browser hosts

The core never imports Electron. Any host can implement `PageAdapter` (reads, tabs, actions, host services). A real CDP implementation is included (`CdpBrowserAdapter`) for Chromium/Electron targets exposing the DevTools Protocol.

Security model:

- Read-only tools are allowed by default; navigation and tab changes prompt for confirmation; file upload/download and arbitrary script execution are blocked by default (`browser_execute_script` is not registered).
- Page text is treated as untrusted data — it is never executed.
- Permission decisions are made by the host callback, never by page content.
- API keys stay in the host process; they are never written to session storage or sent to the browser.

## Development

```bash
npm test          # vitest suite
npm run typecheck # tsc --noEmit
npm run build     # emit dist/
```

## License

MIT. Portions of this project were developed with reference to the public architecture of the [Pi browser](https://github.com/earendil-works/pi) (AGPL-3.0) for design ideas only; no Pi code is included.
