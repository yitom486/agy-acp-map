## v0.1.13 — thin npm package: bunx-first like codex (2026-09-22)

- The 95MB compiled `agy-acp-win-x64.exe` is OUT of the npm tarball
  (`bun run build:exe` now emits `release/agy-acp-win-x64.exe`, uploaded to
  the GitHub Release by CI). npm ships only `dist/bin.js` + `dist/index.js`
  + `dist/agy-headless.exe` (~5MB): first `bunx @yitom/agy-acp-map@latest`
  downloads in seconds, then runs from cache — same shape as codex-acp.
- `acp-studio` launches the bridge via bunx/npx (`@latest`), no managed
  install required.

---

## v0.1.12 — surface agy error_message retries visibly (2026-09-22)

- `step_type: error_message` (model-side failures while agy retries, e.g.
  rate limits) now emits a visible `agent_message_chunk` (“第 N 次尝试遇到
  问题，正在重试…（原因）”) instead of silence. Slow turns caused by
  backend retries no longer look like a hung bridge; the cause travels with
  the turn. (`extractErrorDetail` probes error/message/text/description.)
- NOTE: model-side slowness itself (retries, quotas) is upstream agy/CLI
  behavior, not bridge overhead — the bridge forwards every line in
  milliseconds (see `[ACP-PROC] writeLine` vs `stdout line received`).

---

## v0.1.11 — fix boot self-kill; loud wire harness (2026-09-22)

- **Critical fix**: `AgentApp.connect()` only wires the transport and returns
  immediately — it never runs until close. The v0.1.9 shutdown call placed
  after it therefore killed every boot within ~200ms (all wire e2e hung;
  caught locally, never shipped — v0.1.9 publish failed). Termination now
  happens only on stdin end/close (parent gone) or SIGINT/SIGTERM, still
  killing supervised children (no orphans, no EBUSY on updates).
- **Wire harness fails loud**: spawn error / early server exit now rejects
  pending requests with the exit code instead of hanging 30s silently.

---

## v0.1.10 — publish-pipeline failure diagnostics (2026-09-22)

- CI only: dump `/tmp/agy-acp.log` + lingering test processes when the
  publish job fails, so wire-e2e hangs can be triaged with evidence.
- Runtime identical to v0.1.9.

---

## v0.1.9 — shutdown kills supervised children, no orphans (2026-09-22)

- Bridge exit (`stdin` EOF, `SIGINT`, `SIGTERM`) now awaits
  `service.shutdown()` so warmup/turn `agy` children never orphan and pin
  the install directory (Windows EBUSY blocked on-demand updates).
- `AgyAcpService.shutdown()` facade over the session core.

---

## v0.1.8 — session list titles, incl. backfill (2026-09-22)

- `session/list` rows carry `title` again (first user prompt, one line,
  60 chars): set on first completed turn, backfilled from the history
  journal on resume/load for pre-title sessions (one cheap read, once).
- Studio sidebars render title + relative time instead of raw ids.

---

## v0.1.7 — session list titles & abandoned-empty hiding (2026-09-22)

- `session/list` rows now carry `title` (first user prompt, one line, 60 chars,
  set on first completed turn; surfaces in Studio/Zed sidebars instead of raw ids).
- `session/list` hides abandoned empties: disk-only rows with no
  `conversationId` older than 1h (`EMPTY_SESSION_MAX_AGE_MS`). Rows stay on
  disk (resumable/deletable by id); live in-memory sessions always listed.
- `listSessions` accepts an optional `{ now }` override for deterministic tests.

---

## v0.1.6 — align wire tests with minimal initialize (2026-09-22)

- `tests/protocol-wire-stdio.test.ts` V1 assertions updated to the minimal
  Zed-verified shape (no `_meta` on `initialize`, caps `{close,list,resume}`,
  `authMethods: []`). This un-breaks `prepublishOnly` (`bun test` runs the
  full suite incl. wire tests), which blocked the v0.1.5 npm publish on CI.
- Version bump only otherwise (runtime identical to v0.1.5).

---

## v0.1.5 — Zed-verified minimal initialize, single-file exe, file logging (2026-09-22)

### Fixed
- **Zed handshake**: `initialize` now returns a minimal Zed-verified shape (`protocolVersion`, `agentInfo{name,version}`, `agentCapabilities{loadSession,sessionCapabilities{close,list,resume}}`, `authMethods: []`); models arrive via `session/new` `configOptions` so the Zed model picker keeps working. Verified end-to-end in Zed 1.20.2 (initialize → session/new → prompt).
- **Unit test isolation**: `agent-sdk.test.ts` disables connect-time warm-up (`AGY_ACP_WARMUP=0`) so unit tests never spawn the real `agy` (was slow/flaky without an `AGY_BIN` mock).

### Added
- **Single-file Windows exe**: `bun run build:exe` compiles `dist/agy-acp-win-x64.exe` (codex-style, no Bun/TS at runtime); `acp-studio` preset uses it strictly (missing exe fails fast with a build hint instead of falling back to TS).
- **Headless lookup from compiled exe**: `findHeadlessLauncher` also checks the exe-adjacent directory so `agy` children keep `CREATE_NO_WINDOW` when running from the single file or a global npm install.
- **File logging**: append-only `%TEMP%/agy-acp.log` (`AGY_ACP_LOG` override, ~1MB rotation) recording startup, `initialize`, `session/new`, stdin close and fatal errors — Zed hides `stderr`, the file log does not.
- **Docs**: `README` gained a “Zed via npm (global install)” section with zero-flash and fallback configs plus `exit code: 0` troubleshooting.
- **Hygiene**: `*.bun-build` (Bun `--compile` temp files) added to `.gitignore`.

---

## v0.1.4 — connect-time warmup, real quota windows, Windows headless build matrix (2026-09-22)

### Added
- **Connect-time warm-up**: `session/new` / `session/resume` pre-spawn agy in the background (`AGY_ACP_WARMUP=0` to disable); first prompt reuses the live process. `v1 session/load` stays read-only (no pre-spawn).
- **Real quota windows**: `usage_update.size` now uses verified per-family windows (gemini-3.x 1,048,576; claude-4.6 1M; gpt-oss-120b 131,072; `AGY_ACP_CONTEXT_SIZE` override; CLI-reported hint wins when present). `used` is cumulative input tokens with progressive per-step updates.
- **Windows headless matrix**: `csc.exe` fallback build when Go is missing; PE GUI-subsystem verification; non-Windows cross-compile (`GOOS=windows`) so published npm packages always ship `dist/agy-headless.exe`; CI installs Go.
- **Flash watchdog test**: Zed-like GUI-parent harness proving zero visible console windows through the shim.

### Fixed
- Tool mapping for real wire shapes (`view_file.AbsolutePath`, error objects); stable per-turn `toolCallId`s; per-notification failure isolation in the turn queue.

---

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
