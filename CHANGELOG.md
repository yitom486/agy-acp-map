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

## v0.1.0 — versioning reset (2026-09-20)

Semver reset: the former rapid `0.3`/`0.4`/`0.5` tags are removed from the remote.
This `0.1.0` tag points at the same engineering baseline that was briefly labeled `v0.5.0`
(process manager, allowlists, staging cleanup, Windows image paths, safe defaults, discovery).
Future fixes: `0.1.1`, `0.1.2`, …

---

# Changelog

## Historical note — briefly tagged v0.5.0 (now 0.1.0)

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
- README opinion note + v0.5.0 engineering section
- TEST_MATRIX updated; analysis doc retained

## v0.4.1
- Safe default, slash/timeout, discovery, structured_output

## v0.4.0
- Initial Bun + TypeScript release
