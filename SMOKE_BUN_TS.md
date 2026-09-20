# SMOKE_BUN_TS — Bun + TypeScript migration (v0.4.0)

**When:** 2026-09-20 (Asia/Shanghai)  
**Runtime:** Bun 1.4.2 · agy 1.2.7 · bridge `agy-acp` 0.4.0  
**Entry:** `bun src/server.ts`

## Unit (`bun test src/lib`)

| Suite | Result |
|-------|--------|
| `agy-args.test.ts` (12) | PASS |
| `map-agy-to-acp.test.ts` (9) | PASS |
| `prompt-normalize.test.ts` (4) | PASS |
| `rich-content.test.ts` (5) | PASS |
| `soft-deny.test.ts` (7) | PASS |
| **Total** | **37 pass / 0 fail** |

Also: `bun src/test-agy-args.ts` → 12 checks passed.

## Live smokes (PATH includes `/home/box/.local/bin`)

| Smoke | Command | Result | Notes |
|-------|---------|--------|-------|
| pong | `bun src/client-smoke.ts` | **PASS** | `Reply with exactly: pong` → agent `pong`, idle `end_turn` |
| flags | `bun src/client-smoke-flags.ts` | **PASS** | turn1 + conversation persist + `--conversation` respawn + sandbox + jsonSchema |
| permissions | `bun src/client-smoke-permissions.ts` | **PASS** | `AGY_ACP_SKIP_PERMISSIONS=0`; soft-deny agent_message + parseSoftDeny |
| image-in | `bun src/client-smoke-image-in.ts` | **PASS** | staged `.agy-acp-staging/*.png`; agent read HI / blue |
| image-out | `bun src/client-smoke-image-out.ts` | **PASS** | `generate_image` + ACP image block inlined |
| robustness | `bun src/client-smoke-robustness.ts` | **PASS** | see below |

### Robustness detail

| Check | Pass | Detail |
|-------|------|--------|
| emptyPrompt | PASS | JSON-RPC `-32602` empty prompt after flatten |
| cancelThenNext | PASS | cancel mid-count → next prompt `robustok` |
| invalidModel | PASS | spawn carries bad `--model`; agy stderr loud `invalid model selection` |
| setConfigBusy | PASS | `-32002` session is busy |
| setConfigIdleRespawn | PASS | idle `effort=low` → next spawn has `--effort low` + `cfgok` |
| sessionListConversationId | PASS | `session/list` returns `conversationId` after turn |

## Bun-specific quirks

- Bun runs TypeScript directly (`bun src/server.ts`); no `tsc` emit required (`tsconfig` `noEmit: true`).
- `child_process.spawn(process.execPath, ['src/server.ts'])` works when smokes themselves run under Bun (`execPath` = bun).
- `import.meta.url` + `pathToFileURL` main-guard still works for CLI entry.
- Prefer `bun-types` / built-ins; no Node `@types/node` package required for this tree.
- `PATH` must include `/home/box/.local/bin` for `agy` (server `ensurePath()` prepends it).

## How to re-run

```bash
export PATH="/home/box/.local/bin:$PATH"
cd /workspace/agy-acp-map
bun test src/lib
bun run smoke        # pong
bun run smoke:flags
bun run smoke:permissions
bun run smoke:image-in
bun run smoke:image-out
bun run smoke:robustness
# or full matrix:
bun run smoke:all
```
