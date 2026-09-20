## v0.1.3 — ACP v1/v2 typing, thought stream, FIFO queue & resume handler (2026-09-20)

### Fixed & Added
- **Capabilities Alignment**: Registered active handlers for `session/resume`, `session/load`, and `session/set_config_option` in `agent-sdk.ts`.
- **Thought Streaming**: Implemented `step_update.agent_response.thought_delta` mapping to ACP `agent_thought_chunk`.
- **Sequential Notification Queue**: Added `AsyncSerialQueue` in `agent-sdk.ts` to serialize notification events in strict FIFO order, eliminating async delivery races.
- **Promise Anti-pattern Removed**: Removed `new Promise(async ...)` in `promptSession()`.
- **Discovery Bug**: Fixed `initialize()` accessing undefined `discovery.models` / `discovery.agents` by using `discovery.availableModels` / `discovery.availableAgents`.
- **Staging Lifecycle**: Per-turn automatic cleanup of temporary staging files in `.agy-acp-staging` (respecting `AGY_ACP_KEEP_STAGING=1`).
- **Version Normalization**: Aligned all package manifests and components strictly to `v0.1.3`.

---

## v0.1.2.1 — docs (2026-09-20)

- Document non-goals: no OneShot `-p` backend; no permission round-trip; no history replay in bridge.

---

## v0.1.2 — disk SessionStore + resume rehydrate (2026-09-20)

Lightweight on-disk session index for ACP `sessionId` ↔ agy `conversationId` mapping and launch-config snapshots. **Full transcript stays Client-side** (zustand / gateway). No history replay.

### Added
- `src/lib/session-store.ts` — JSON store (default `~/.agy-acp-map/sessions.json`, or `AGY_ACP_STORE` / `AGY_ACP_SESSION_STORE`)
  - atomic save (temp + rename); `upsert` / `get` / `list({ cwd? })` / `delete|remove`
- `session/new` upserts store even before `conversationId` is known
- Mapper `conversationId` / title / config / turn-complete → upsert
- `session/list` merges in-memory + disk (**prefer memory** when both)
- `session/resume` rehydrates from disk when not in memory (no agy child yet; next prompt spawns with `--conversation` + saved flags). **Does not** replay history via `session/update`
- `session/close` keeps disk row by default; `AGY_ACP_DELETE_ON_CLOSE=1` also deletes store row

### Changed
- `BRIDGE_CAPABILITIES.historyReplay`: `false` (was `'adapter'`) — advertise no history replay
- `resume: true` + initialize notes: lightweight id/config store only
- AGENT_INFO / package version → **0.1.2**

### Not in scope
- No `session/load` history replay
- Store does **not** hold messages / tool traces / NDJSON transcripts

### Tests
- Unit: session-store CRUD + atomic write + resume rehydrate seed (`bun test src/lib`)

---

## v0.1.1 — three-tier safety (2026-09-20)

Clearer launch-time safety using existing agy flags. **No interactive ACP permission UI.**

### Added
- Third safety tier: `autonomous-unsandboxed` (aliases: `autonomous_unsandboxed`, `unsandboxed`)
- Central `resolveSafety(session/env) → { safety, skipPermissions, sandbox }` in `src/lib/agy-args.ts`
- `BRIDGE_CAPABILITIES.safetyTiers` + `permissionMode: "safety_tiers"` (+ `permissionRoundTrip: false`)
- `session/new` / env `AGY_ACP_SAFETY` / `session/set_config_option` accept all three tiers

### Behavior
| Tier | `--dangerously-skip-permissions` | `--sandbox` |
|------|----------------------------------|-------------|
| **safe** (default) | no | only if user sets `sandbox: true` / `AGY_ACP_SANDBOX=1` |
| **autonomous** | yes | default on; off if `sandbox: false` / `AGY_ACP_SANDBOX=0` |
| **autonomous-unsandboxed** | yes | **never** (forces omit even if sandbox true) |

Backward compat: `AGY_ACP_SKIP_PERMISSIONS=1` ≈ autonomous when safety unset; `=0` ≈ safe.

### Docs / tests
- README 中英 three-tier table; unit tests for all tiers + overrides

---

## v0.1.0 — versioning baseline (2026-09-20)

Engineering baseline (process manager, allowlists, staging cleanup, Windows image paths, safe defaults, discovery).
Future fixes: `0.1.1`, `0.1.2`, `0.1.3`…

---

# Changelog

## Historical note — early engineering baseline (now 0.1.0)

P0 items from `docs/AGY_ACP_MAP_ANALYSIS.zh-CN.md` §12.

### Added
- `src/lib/agy-process.ts` — process manager with generation tokens, graceful→force kill, stale NDJSON ignore
- `src/lib/path-allowlist.ts` — session-root allowlist for image reads (cwd / staging / additionalDirectories)
- Staging size limits: 8MB per blob, 32MB per turn; cleanup after turn idle / session close / shutdown
- Env `AGY_ACP_KEEP_STAGING=1` to retain staging files for debug
- Mapper: `result.response` fallback when no `text_delta`; `CANCELLED`/`INTERRUPTED` → `stopReason: cancelled`
- `session/new` validates that `cwd` exists and is a directory

### Fixed
- Child `error` event → ACP agent_message + idle (no unhandled EventEmitter errors)
- Cancel / set_config / close / shutdown share one kill path (SIGINT → SIGTERM → SIGKILL / Windows `taskkill`)
- Soft-deny: generic tool ERROR no longer treated as permission deny
- Relative image output paths resolve against session cwd (not `process.cwd()`)

### Docs
- README opinion note + engineering section
- TEST_MATRIX updated; analysis doc retained

## v0.4.1
- Safe default, slash/timeout, discovery, structured_output

## v0.4.0
- Initial Bun + TypeScript release
