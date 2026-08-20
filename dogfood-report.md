# Tony Agent Codebase Survey & Analysis Report

- **Target Repository**: `/tmp/tony-agent-work`
- **Package Name**: `tony-agent`
- **Package Version**: `0.8.1` (package.json) | *Note: ARCHITECTURE.md references v0.8.0*
- **Report path note**: requested `/tmp/tony-dogfood-report.md` was blocked by the workspace sandbox (path escape), so the report was written to `/tmp/tony-agent-work/dogfood-report.md`.

---

## 1. Package Overview & Key Scripts

From `package.json`:
- **Name**: `tony-agent`
- **Version**: `0.8.1`
- **Bin**:
  - `tony`: `./dist/cli/main.js`
  - `tony-agent`: `./dist/cli/main.js`
- **Main Scripts**:
  - `npm run test`: `vitest run`
  - `npm run test:coverage`: `vitest run --coverage`
  - `npm run test:watch`: `vitest`
  - `npm run build`: `tsc -p tsconfig.build.json`
  - `npm run typecheck`: `tsc --noEmit`
  - `npm run cli`: `tsx src/cli/main.ts`
  - `npm run dev` / `npm run demo`: `tsx src/cli/demo.ts`
  - `npm run smoke`: `tsx scripts/smoke.ts`
  - `npm run bench`: `tsx scripts/bench.ts`

---

## 2. Test File Count & Core Architecture Modules

### Test File Count
- Total test files matching `*.test.ts` under `tests/`: **85 test files**
  (82 in `tests/` root, 3 in `tests/plugin/`, 1 in `tests/seams/`, 1 in `tests/session/`).

### Core Architecture Modules (`src/`)
- `agent.ts`: Legacy agent loop & permission enforcement.
- `runtime.ts`: `TonyRuntime` session orchestration (hydration, persistence, compaction).
- `harness/`: Pi-mirror Agent with crash-recovery harness, hook system, steering queues, parallel batches.
- `tools/`: Tool registry + manager + scope; browser tools; workspace-confined coding tools (`read`, `write`, `edit`, `ls`, `grep`, `find`).
- `query/`: Derived FTS5 SQLite search engine & LightRAG-style Knowledge Graph (`searchGraph`, `searchRelated`, `GraphContextBuilder`).
- `workflow/`: `WorkflowEngine` script orchestration fanning out subagents via `ctx.agent()`, and graph-directed routing (`GraphRouter`).
- `plan/`: Graph-directed execution planner (`GraphPlanner`, `GroupPlanner`) synthesizing DAG execution plans.
- `cli/`: Command-line interface (`main.ts`, `args.ts`, `theme.ts`, `demo.ts`).
- `subagent/`: In-process subagent registry & provider tool (`delegate_subagent`).
- `code-runtime/`: Worker-thread isolated sandbox for `run_code` execution.
- `permissions/`: Declarative allow/confirm/deny policies, fail-closed.
- `plugin/`, `seams/`, `fs/`, `shell/`, `skills/`, `approval/`, `events/`, `hooks/`, `memory/`, `auth/`, `host/`, `server/`, `client/`, `protocol/`.

---

## 3. Findings (Specific Weaknesses & Issues)

### Finding 1 — SQL operator-precedence bug in `searchRelated` (cross-session leak)
- **File & Line**: `src/query/engine.ts:167`
- **Issue**: The SQL condition
  ```sql
  WHERE source IN (...) OR target IN (...) AND session_id = @sid
  ```
  evaluates as `(source IN (...)) OR (target IN (...) AND session_id = @sid)` because `AND` binds tighter than `OR`. When a `sessionId` is supplied, relations whose `source` matches bypass the session filter and leak cross-session data into the transitive recall.
- **Proposed Fix**: Parenthesize the OR clause:
  ```sql
  WHERE (source IN (...) OR target IN (...)) AND session_id = @sid
  ```

### Finding 2 — Dead code: unused `contextFactory` suppressed with `void`
- **File & Line**: `src/tools/coding/index.ts:18` and `:141`
- **Issue**: `const contextFactory = () => ({ sessionId: 'coding', metadata: {} })` is defined but never used; `void contextFactory` at line 141 is an explicit no-op to silence the linter.
- **Proposed Fix**: Remove `contextFactory` (and the `void`), or wire it into the tool executions if session metadata should be attached to results.

### Finding 3 — Version drift between ARCHITECTURE.md and package.json
- **File & Line**: `ARCHITECTURE.md:8`
- **Issue**: Docs state `Version: **0.8.0**` while `package.json` declares `"version": "0.8.1"` (and README advertises up to v0.8 features).
- **Proposed Fix**: Update `ARCHITECTURE.md` line 8 to `Version: **0.8.1**` (or auto-derive from package.json) to keep docs truthful.

### Finding 4 (bonus) — No-op `log` in `WorkflowContext`
- **File & Line**: `src/workflow/engine.ts:109`
- **Issue**: `log: () => {}` silently discards all workflow-script log output, making debugging model-written orchestration scripts harder; the documented `ctx.log(message)` does nothing.
- **Proposed Fix**: Route to `console.log` or an event bus (e.g. `events.emit('workflow:log', ...)`), or drop the API if intentionally unsupported.

---
