# Smoke test result (v0.2.0)

- **When**: 2026-09-20 ~10:56 Asia/Shanghai (UTC+8)
- **Outcome**: **PASS**
- **agy mode**: persistent stdin stream-json
- **Prompt**: `Reply with exactly: pong`
- **cwd**: `/workspace/agy-acp-map`

## Observed

1. `initialize` → `protocolVersion: 2`, `info: agy-acp@0.2.0`, `bridgeCapabilities` (full table), `authMethods: []`
2. `session/new` → `sessionId`
3. `session/prompt` → early `{ messageId }`
4. `agent_message_chunk` → `pong`
5. `usage_update` + `state_update` idle `end_turn`

## Checks

| Check | Result |
|-------|--------|
| initialize ok (v2) + bridgeCapabilities | yes |
| session/new sessionId | yes |
| prompt messageId | yes |
| agent_message_chunk (`pong`) | yes |
| state_update idle end_turn | yes |

Command: `export PATH="/home/box/.local/bin:$PATH" && node client-smoke.mjs` (exit 0).
