# Robustness smoke (Bun + TypeScript) — v0.5.0

Date: 2026-09-20T16:57:34+08:00 (Asia/Shanghai)

| Check | Result | Detail |
|-------|--------|--------|
| emptyPrompt | PASS | `-32602` empty prompt after flattening |
| cancelThenNext | FAIL* | cancel/kill/respawn worked; next-turn text was **429** not `robustok` |
| invalidModel | PASS | loud spawn failure for unknown model |
| setConfigBusy | PASS | `-32002` while busy |
| setConfigIdleRespawn | FAIL* | respawn with new flags + `--conversation` seen; text was **429** not `cfgok` |
| sessionListConversationId | PASS | conversationId persisted |

\* Failures are **quota** (`RESOURCE_EXHAUSTED` / 429), not bridge regressions. Process supervision paths (cancel → kill → next prompt; set_config → kill → respawn) were exercised.

## Overall: **PARTIAL** (bridge OK; content assertions blocked by quota)

Re-run after quota reset for full PASS.
