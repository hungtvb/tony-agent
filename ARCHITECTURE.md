# Tony Agent — Architecture

Self-built **pure TypeScript agent harness** (no agent-harness dependency): the
agent loop, LLM transport, tool system, permission policy, durable sessions,
remote protocol, plugin system, and capability seams are all implemented in
this repository. The browser CDP adapter is an **optional host adapter** only.

Version: **0.8.0**

## Layout

```
src/
├─ agent.ts            # TonyAgent — legacy agent loop (PermissionPolicy, resolvePermission)
├─ runtime.ts          # TonyRuntime — session orchestration (hydrate, persist, compact)
├─ index.ts            # public API surface (all exports)
├─ types.ts            # shared types: LLMMessage, TonyTool, SessionEntry, AgentEvent…
├─ llm/                # LLM layer: client, model abstraction, providers, tokens, auth
│  └─ auth/            # CredentialStore (0600 real-key persist) + resolve
├─ protocol/           # framed CBOR remote protocol
├─ server/ client/     # remote session server + client
├─ query/              # derived indexes (v0.5+): FTS5 session query + Graph layer
│  ├─ engine.ts        #   SessionQueryEngine — sync/search/trace + searchGraph (local/global/naive)
│  ├─ graph-context.ts #   GraphContextBuilder — per-turn recall block w/ [session#seq] citations (v0.6.1)
│  ├─ extractor.ts     #   GraphExtractor — LLM EXTRACT role, fail-soft (v0.6)
│  └─ plugin.ts        #   query:search / query:graph tools
├─ session/            # session lanes store, compaction, log (source of truth)
├─ harness/            # pi-mirror Agent (hooks, steering, parallel batches, approval seam)
│  ├─ agent.ts         #   events, hooks, steering queues, parallel batches
│  ├─ agent-harness.ts #   crash-recovery harness
│  ├─ session/         #   entry model, JSONL + SQLite backends, compaction
│  └─ compaction/      #   summarization + branch summarization
├─ permissions/        # PermissionPolicy — allow/confirm/deny, fail-closed
├─ tools/              # ToolRegistry, ToolsManager, ToolScope (per-agent mask), browser/coding tools
├─ plugin/             # v0.3 plugin core: PluginRegistry, EventBus, PatchLayer, PluginContext
├─ seams/              # ServiceDefinition/Provider/Consumer + ServiceRegistry (one active provider)
├─ fs/                 # fs service seam — definitions + local provider + consumer tools
├─ shell/              # shell service seam — definitions + local provider + consumer tool
├─ config/             # profile system (headless/web bundles) via patch layers
├─ skills/             # SkillRegistry + directory provider + model-facing skill tool
├─ approval/           # ApprovalProvider seam (fail-closed when unmounted)
├─ code-runtime/       # run_code transport + worker-thread runtime (empty vm context sandbox)
├─ subagent/           # SubagentRegistry + in-process provider + delegate_subagent tool
├─ workflow/           # WorkflowEngine — script orchestration fan-out
│  ├─ engine.ts        #   ctx.agent/route/routeAgents + per-run route cache
│  └─ router.ts        #   GraphRouter — heuristic routing over the graph (v0.7)
├─ plan/               # Graph planning (v0.8)
│  ├─ types.ts         #   TaskNode/TaskEdge/Plan model
│  ├─ group.ts         #   GroupPlanner — deterministic DAG from entities
│  ├─ planner.ts       #   GraphPlanner — engine-backed, LLM refine (fail-soft)
│  └─ execute.ts       #   planToScript/executePlan — DAG execution on WorkflowEngine
├─ events/             # ToolCallWaterfall (deny>ask>allow, fail-closed) + EventBus
├─ hooks/              # Claude-Code/Codex hooks bridge (matcher groups, exit-code contract)
├─ memory/             # MemoryAdapter port + InMemoryVectorStore
├─ auth/               # OAuth 2.0 PKCE provider (RFC 7636)
├─ host/               # optional PageAdapter + CDP adapter (browser host)
└─ cli/                # argv parser + main CLI (run, sessions, profiles, doctor…)
```

## Core invariants

1. **Session log is the single source of truth.** `src/session/log.ts`
   `deriveMessages(entries)` projects model history; fork/resume/compact/
   telemetry all derive from this stream. `assertModelVisibleIsLogged`
   (opt-in `TONY_AGENT_ASSERT_LOG=1`) fails closed when a model-visible
   message is not reconstructable from the log.
2. **Deny by default.** Missing permission policy rule = rejection. A seam
   without a mounted provider (`ServiceRegistry.resolve`) throws. The code
   runtime runs in an **empty vm context** — regex policy is defense-in-depth
   only, the real boundary is context isolation.
3. **Provider swap needs no consumer change.** Capabilities (fs, shell, llm,
   memory, subagents) are Service seams: one active provider per definition;
   consumers wrap the resolved service into model-facing tools.
4. **Derived indexes never pollute the source of truth.** The session log is
   the only log; FTS5 search + knowledge-graph data live in a separate derived
   index DB (`index.db`) and are rebuilt/synced from entries on demand.
   Graph Context Recall (v0.6.1) is **read-only** over that index and its
   per-turn system block is **ephemeral** — never persisted into history — so
   model-visible recall is always reconstructable from the log alone.

## Plugin & seams (v0.3)

- `PluginRegistry.mount(plugin, ctx)` — `setup(ctx)` returns `PluginEffect
  { dispose() }`; unmount awaits disposer, LIFO unwind. Duplicate mount /
  unknown unmount throw.
- `EventBus` — broadcast emit is fail-open (telemetry semantics); waterfall
  reuses `ToolCallWaterfall` (deny>ask>allow).
- `ServiceRegistry` — ONE active provider per definition; `resolve()` fail-
  closed; `consume(id, consumer)` wraps the service into `TonyTool[]`.
- Built-in seams: **fs** (`fs_read`/`fs_write`/`fs_list`), **shell**
  (`shell_run` — allow-list, execFile no-shell, timeout), **subagent**
  (`delegate_subagent` — own session, toolFilter, provider override).

## Config profiles

`src/config/profiles.ts` — named bundles (headless/web) as patch layers:
base rows < profile rows < override rows, later wins, `disabled` removes a
row. CLI: `profile <name>`, `dump-config --profile <name>`, `--profile`.

## Verification

```bash
npm test          # vitest full suite (pool=forks, better-sqlite3 pinned)
npm run build     # tsc
npm run smoke     # e2e smoke — full loop with ScriptedLLM
npm run bench     # latency benchmarks
```

CI: GitHub Actions cross-check + check on push (Node 20 + 22).
