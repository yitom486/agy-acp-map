# Smoke result — v0.5.0 (2026-09-20 Asia/Shanghai)

## Unit
`bun test src/lib` → **77 pass / 0 fail**

## Live

### `AGY_ACP_SAFETY=autonomous AGY_ACP_PRINT_TIMEOUT=20s bun src/client-smoke.ts`
- **SMOKE PASS** (init / session / messageId / chunk / idle / bridgeCaps)
- Agent chunk was **429 RESOURCE_EXHAUSTED** (quota), not literal `pong`
- Bridge correctly surfaced error text + `state_update idle end_turn`
- Without short `printTimeout`, autonomous+sandbox can sit in retries until client 90s timeout

### `AGY_ACP_SAFETY=autonomous AGY_ACP_PRINT_TIMEOUT=15s bun src/client-smoke-robustness.ts`
- emptyPrompt / invalidModel / setConfigBusy / sessionListConversationId → **pass**
- cancelThenNext / setConfigIdleRespawn → **fail** only because response text was 429 not `pong`
- Process supervision (cancel kill, set_config respawn, close) exercised successfully

Quota note: `Individual quota reached … Resets in ~76h` at test time. Re-run live smokes after reset for content assertions.
