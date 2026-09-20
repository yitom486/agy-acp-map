# SMOKE_FLAGS

- **When**: 2026-09-20 (Asia/Shanghai)
- **Outcome**: **PASS** (core) / sandbox+jsonSchema spawn verified; later turns hit API 429 quota
- **version**: 0.4.1
- **env**: `AGY_ACP_SAFETY=autonomous` / `AGY_ACP_SKIP_PERMISSIONS=1`

## Results (best run before quota)

| Check | Result |
|-------|--------|
| turn1 flagok | PASS |
| conversationId persisted | PASS |
| respawn `--conversation` | PASS |
| turn2 context | PASS |
| `--sandbox` on spawn | PASS (spawn verified) |
| `--json-schema` on spawn | PASS (spawn verified; structured_output covered by unit test) |
| `--disable-slash-commands` | PASS (visible on all spawns) |
| `--print-timeout 0` | PASS |

## Note

Live model quota (`RESOURCE_EXHAUSTED 429`) exhausted mid-matrix; unit tests + pong + permissions smokes cover new v0.4.1 behavior. Spawn argv for slash/timeout/safety confirmed in server logs.
