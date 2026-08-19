# Tony Agent

Self-built, pure TypeScript agent harness. No agent harness dependency — the agent loop, LLM transport, tool system, permission policy, durable sessions, remote protocol, plugin system, and capability seams are all implemented in this repository. **v0.5.0** adds Session Query (FTS5): a derived, rebuildable full-text index over session history with `search` CLI, snippet highlighting, keyset cursor paging, session-level aggregation, and session/event lineage tracing. Also typed EventBus (EventMap + `emit<K>` type-checked) and snapshot test fixtures (record/replay ScriptedLLM steps).

- **Unified LLM layer** — `Models`/`Api` abstraction with provider adapters (OpenAI-compatible, Anthropic, OpenRouter, Vercel gateway), model discovery, and a credential store persisting real keys (0600) so restarts survive.
- **Agent loop** — bounded LLM → tool → result loop with streaming deltas, per-turn and per-run limits, loop detection, abort, and event stream.
- **Stateful harness** — `Agent` class with hooks (`beforeToolCall`/`afterToolCall`/`transformContext`), steering/follow-up queues, sequential + parallel tool batches, loop guards.
- **Durable sessions** — entry model with lanes; JSONL repo (atomic writes, branching, corruption-tolerant) and SQLite backend (WAL + integrity pragmas, FK-safe upserts); compaction + branch summarization; session log as the single source of truth (`deriveMessages`).
- **Plugin system** — `PluginRegistry` (mount/unmount reversible effects, LIFO unwind), `EventBus` (broadcast fail-open + waterfall), `PatchLayer` (config patch by row id + session-scoped overrides via `applyForSession`), `ServiceRegistry` (one active provider per definition, fail-closed resolve, quiescence teardown `dispose()` waits in-flight settle).
- **Capability seams (v0.3)** — fs (`fs_read`/`fs_write`/`fs_list`, workspace-confined), shell (`shell_run` — allow-list, no-shell execFile, timeout, cooperative abort), subagent (`delegate_subagent` — own session + toolFilter + cold resume from persisted transcript). Provider swap needs no consumer change.
- **Config profiles** — headless/web bundles as patch layers; CLI `profile` + `dump-config`.
- **Tools (v0.4)** — presentation modes `native`/`code`/`both` projected per surface; `run_code` code-mode transport; registry filter at call site; ToolContext carries the active presentation.
- **Permissions** — per-tool/site policy: `allow` / `confirm` / `deny`, allow-once vs allow-session, fail-closed.
- **Remote protocol** — framed CBOR (4-byte length + CBOR body) with `TonyServer`/`TonyClient` for remote sessions.
- **Security** — code runtime in an empty vm context (no `require`/`process` escape), OAuth 2.0 PKCE (RFC 7636), hooks bridge with exit-code contract.
- **Testing (v0.4)** — vitest coverage gate (`npm run test:coverage`) with v8 provider + thresholds + dedicated CI job; smoke `npm run smoke`.
- **Session Query (v0.5)** — FTS5 derived index (`src/query/`): `SessionQueryEngine` with `sync`/`searchEvents`/`searchSessions`/`traceSession`/`traceEvent`, literal-phrase semantics (FTS keywords treated as data), snippet highlighting, keyset cursor paging, lineage cycle-safety, and a live TEMP shadow surface fold. CLI: `tony-agent search "<query>" [--session <id>] [--json]`. **v0.5.1** wires the `query:search` tool into both agent loops (runtime + CLI), so the model can recall past sessions mid-conversation.

See `ARCHITECTURE.md` for the full module map and core invariants.

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

# Config profiles (v0.3)
npm run cli -- profile web
npm run cli -- dump-config --profile web
```

Flags: `-p/--prompt`, `-s/--session`, `--data-dir`, `--base-url`, `--api-key`, `--model`, `--max-turns`, `--non-interactive`, `--offline`, `--no-stream`, `--json`, `--profile`.

Commands: `run`, `prompt`, `new`, `steer`, `abort`, `fork`, `compact`, `export`, `switch`, `list`, `get`, `clone`, `set`, `cycle`, `server`, `client`, `models`, `doctor`, `profile`, `dump-config`.

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
