# SMOKE_PERMISSIONS

- **When**: 2026-09-20T05:17:29.949Z (box local Asia/Shanghai)
- **Outcome**: **PASS**
- **AGY_ACP_SKIP_PERMISSIONS**: 0 (no --dangerously-skip-permissions)
- **stopReason**: end_turn
- **softDenyNotify (agent_message)**: true
- **parseSoftDeny count**: 1
- **jetskiStderr**: true
- **toolFailed**: false

## parseSoftDeny result
```json
[
  {
    "tool": "run_command",
    "allowRule": "command(<target>)",
    "source": "stderr-jetski"
  }
]
```

## Agent text
```
Headless soft-deny: one or more tools were auto-denied (no interactive permission UI).
Suggested settings.json permissions.allow rules:
- tool=run_command allow-rule=command(<target>) (via denied_actions)
Or set AGY_ACP_SAFETY=autonomous / AGY_ACP_SKIP_PERMISSIONS=1 (safe is the bridge default).
```

## Stderr excerpt
```
[agy-acp] agy-acp 0.4.1 ready (stream-json stdin bridge) safety=safe skipPermissions=0
[agy-acp] spawn agy skipPermissions=0 safety=safe cwd=/workspace/agy-acp-map/smoke-workdir-perms disableSlash=1 printTimeout=0 args=["-p","","--input-format","stream-json","--output-format","stream-json","--disable-slash-commands","--print-timeout","0","--add-dir","/workspace/agy-acp-map/smoke-workdir-perms"]
[agy stderr] jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)). Alternatively, re-run with --dangerously-skip-permissions to auto-approve all tools.

```

## Note
Soft-deny surfaced as agent_message_chunk with suggested allow-rules.
