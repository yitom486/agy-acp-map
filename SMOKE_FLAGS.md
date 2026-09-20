# SMOKE_FLAGS (v0.3.0)

**Date:** 2026-09-20 (Asia/Shanghai)  
**Command:** `export PATH="/home/box/.local/bin:$PATH" && node client-smoke-flags.mjs`  
**Model pin:** `gemini-3.8-flash-high` (first flash from `agy models`)  
**Result:** **PASS**

## Checks

| Check | Result | Notes |
|-------|--------|-------|
| `initialize` version / caps | OK | `info.version=0.3.0`, `dynamicConfig=restart`, `resume=true` |
| `session/new` + model | OK | `_meta.model` echoed |
| `session/set_config_option` model | OK | idle update |
| Turn 1 «flagok» | PASS | agent replied `flagok` |
| `conversationId` in `session/list` | PASS | e.g. `09e3aa98-…` |
| Cancel → respawn `--conversation` | PASS | spawn log includes `--conversation <id>` |
| Turn 2 context resume | PASS | answered `flagok` after kill |
| `sandbox: true` | PASS | spawn has `--sandbox`; replied `sandboxok` |
| `jsonSchema` object | PASS | spawn has `--json-schema`; turn `idle` / `end_turn` |

## Unit

```bash
node test-agy-args.mjs   # 12 checks, no live agy
```

## Limitations observed

- Cancelling an idle persistent child makes agy exit with `stream input cancelled: context canceled` (expected; next prompt respawns).
- Structured schema output may only appear in agy’s internal `result.structured_output`; mapper does not yet surface it as ACP content — smoke only requires spawn flag + SUCCESS idle.
- Invalid model ids fail at agy (loud stderr); bridge does not pre-validate.
