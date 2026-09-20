# Changelog

## v0.5.0 — engineering hardening (2026-09-20)

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
