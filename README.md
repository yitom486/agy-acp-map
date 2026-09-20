# agy-acp-map — ACP v2 ↔ agy stream-json bridge (v0.4 · Bun + TypeScript)

**English** | **中文**

## What is NDJSON / stream-json?

NDJSON (Newline-Delimited JSON), also called JSONL, is a framing where each line is one complete JSON value. Both ACP stdio JSON-RPC and `agy --output-format stream-json` use this: the agent writes one JSON-RPC object per line on stdout; agy emits one event object per line (`init`, `step_update`, `result`). No length prefixes, no SQLite — just lines.

NDJSON（换行分隔 JSON / JSONL）是一种按行分帧的格式：每一行是一个完整的 JSON 值。ACP 的 stdio JSON-RPC 与 `agy --output-format stream-json` 都采用这种方式。不依赖 SQLite，也不使用长度前缀。

> **Note:** There is **no** `agy acp` subcommand. This bridge (`agy-acp` / `src/server.ts`) is a third-party ACP agent that spawns the normal `agy` CLI with stream-json.  
> **说明：** 不存在 `agy acp` 子命令。本仓库是第三方 ACP agent，通过官方 `agy` CLI 的 stream-json 桥接。

## Architecture / 架构

```
ACP Client  ←stdio JSON-RPC NDJSON→  src/server.ts  ←stdin/stdout stream-json→  agy CLI
                                      │
                                      ├─ src/lib/map-agy-to-acp.ts
                                      ├─ src/lib/agy-args.ts          (buildAgyArgs / launch flags)
                                      ├─ src/lib/prompt-normalize.ts  (image → files)
                                      ├─ src/lib/rich-content.ts      (paths → ACP image)
                                      └─ src/lib/soft-deny.ts         (stderr soft-deny)
```

- **No SQLite**: never reads `~/.agy` DBs or conversation stores.
- **No Zed / Antigravity plugin code**.
- **Persistent stdin stream-json** (same child across turns until cancel/config change).
- **Resume:** after cancel/kill/crash, respawn passes `--conversation <id>` when known.

## Requirements / 环境

- Bun ≥ 1.1 (tested 1.4.2) + TypeScript sources under `src/`
- `agy` on PATH (`export PATH="/home/box/.local/bin:$PATH"`) and logged in

## Run / 运行

```bash
export PATH="/home/box/.local/bin:$PATH"
cd /workspace/agy-acp-map

bun src/server.ts                 # ACP stdio agent
bun test                          # unit (37)
bun src/test-agy-args.ts          # legacy args script

# Live smokes (need logged-in agy)
bun src/client-smoke.ts           # pong
bun src/client-smoke-permissions.ts
bun src/client-smoke-image-in.ts
bun src/client-smoke-image-out.ts   # may take longer
bun src/client-smoke-flags.ts       # model / --conversation / sandbox / json-schema
bun src/client-smoke-robustness.ts  # cancel / empty / bad model / set_config / list

bun run smoke:all                 # units + full live matrix
```

**Windows:** install [Bun](https://bun.sh), put `agy` on `PATH`, then the same commands.


## Launch flags / 启动参数 (v0.3)

Configure on **`session/new`** (preferred) and/or env fallbacks. Stored on the Session; every `spawnAgy` builds argv via `buildAgyArgs(session)`.

在 **`session/new`** 上配置（优先），或用环境变量兜底。写入 Session；每次 spawn 由 `buildAgyArgs` 组装参数。

| agy flag | `session/new` field | env fallback |
|----------|---------------------|--------------|
| `--model` | `model` or `_meta.model` or `config.model` | `AGY_ACP_MODEL` |
| `--effort` | `effort` / `_meta` / `config` | `AGY_ACP_EFFORT` |
| `--mode` | `mode` (`accept-edits` \| `plan`) | `AGY_ACP_MODE` |
| `--agent` | `agent` | `AGY_ACP_AGENT` |
| `--sandbox` | `sandbox: true` | `AGY_ACP_SANDBOX=1` |
| `--json-schema` | `jsonSchema` (string or object→stringify) | `AGY_ACP_JSON_SCHEMA` (string or path) |
| `--conversation` | `conversationId` (resume / switch-model flow) | _(from prior turn)_ |

Also accepts a simple ACP-ish `configOptions: [{ id\|configId, value }, ...]`.

Invalid model / effort values fail **loud** at agy spawn (stderr + turn ends); the bridge does not validate catalog ids.

无效的 model/effort 会在 agy 启动时失败（stderr 可见）；桥接层不做模型目录校验。

### Resume & dynamic config / 恢复与动态配置

1. **First spawn** of a brand-new session: omit `--conversation`.
2. Mapper learns `conversation_id` from agy `init`/`result` → persisted as `session.conversationId`.
3. Exported in `session/new` result `_meta`, `session/list` (`conversationId` + `_meta`), and `session/resume` `_meta`.
4. After cancel/kill/crash **respawn**: `--conversation <id>` so Agent-side context resumes.
5. **Change model mid-life (recommended):** wait idle → `session/close` → `session/new` with `{ cwd, conversationId, model, ... }`.
6. **Or** idle `session/set_config_option`:
   ```json
   { "sessionId": "...", "configId": "model|effort|mode|agent|sandbox|jsonSchema", "value": "..." }
   ```
   Updates session fields, kills lingering child; **next** `session/prompt` respawns with new flags + `--conversation`. When busy → error `-32002`.

`bridgeCapabilities.dynamicConfig: "restart"` · `resume: true` (conversation flag on respawn).

## Env / 环境变量

| Env | Default | Meaning |
|-----|---------|---------|
| `AGY_ACP_SKIP_PERMISSIONS` | `1` | When `1`, spawn with `--dangerously-skip-permissions`. When `0`, headless soft-deny; bridge scrapes stderr and emits suggested allow-rules. |
| `AGY_BIN` | `agy` | Override binary |
| `AGY_ACP_MODEL` | — | Default `--model` |
| `AGY_ACP_EFFORT` | — | Default `--effort` |
| `AGY_ACP_MODE` | — | Default `--mode` |
| `AGY_ACP_AGENT` | — | Default `--agent` |
| `AGY_ACP_SANDBOX` | — | `1` → `--sandbox` |
| `AGY_ACP_JSON_SCHEMA` | — | Schema string or file path for `--json-schema` |

## `initialize` → bridgeCapabilities

Returned alongside standard ACP fields (also under `_meta.bridgeCapabilities`):

| Field | Value | Notes |
|-------|-------|-------|
| `prompt` | `true` | |
| `streaming` | `true` | |
| `tools` | `true` | Mapped from agy tool steps |
| `resume` | `true` | Persists `conversationId`; respawn passes `--conversation` |
| `permissionRoundTrip` | `false` | No ACP permission UI |
| `permissionMode` | `preset_or_dangerously_skip` | Env flag or settings.json allow rules |
| `nativeCancel` | `false` | |
| `cancelMode` | `SIGINT_then_KILL` | |
| `historyReplay` | `adapter` | Gateway must own transcript |
| `dynamicConfig` | `restart` | `session/new` + idle `set_config_option` / close+new |
| `richContentInput` | `degrade_to_files` | Images → `.agy-acp-staging/` + text path |
| `richContentOutput` | `best_effort` | Detect paths; inline base64 ≤2MB |
| `clientFilesystem` | `false` | |
| `clientTerminal` | `false` | |

## Image / rich content strategy / 富内容策略

**Input:** agy stream-json stdin **rejects** non-text content blocks. The bridge stages `image` / binary `resource` / `audio` under `<cwd>/.agy-acp-staging/<uuid>.<ext>` and injects text like:

```
User attached an image file at: /abs/path.png
Please open/view that file and answer based on what you see.
```

`--add-dir <cwd>` covers the staging directory.

**Output:** When tools (especially `generate_image`) or agent text mention `png|jpg|webp|gif` paths, the mapper adds ACP `{ type: 'image', mimeType, data }` (base64) if the file exists and is ≤2MB; otherwise path text only.

## Soft-deny / 权限

Without skip-permissions, agy may stderr e.g.:

> a tool required the "command" permission … auto-denied. Add an allow-rule … (e.g. command(\<target\>))

`src/lib/soft-deny.ts` parses these; at turn end the server emits an `agent_message_chunk` listing suggested allow rules.

## Files / 文件

| File | Role |
|------|------|
| `src/server.ts` | ACP v2 stdio server |
| `src/lib/agy-args.ts` | `buildAgyArgs` / `extractLaunchConfig` |
| `src/lib/map-agy-to-acp.ts` | agy event → ACP updates |
| `src/lib/prompt-normalize.ts` | ContentBlock → text + staging |
| `src/lib/rich-content.ts` | Image path extract / ACP image block |
| `src/lib/soft-deny.ts` | Stderr soft-deny parser |
| `src/test-agy-args.ts / `bun test`` | Unit tests (no live agy) |
| `src/client-smoke*.ts` | Smokes |
| `fixtures/tiny.png` | Blue “HI” PNG for image-in |
| `SMOKE_*.md` | Smoke reports |

## Limitations / 限制

- MCP servers from `session/new` ignored (agy has its own).
- No ACP permission round-trip UI (`permissionRoundTrip: false`).
- Cancel = SIGINT then SIGKILL (no mid-turn stream cancel API).
- History replay is adapter-owned (`historyReplay: 'adapter'`).
- Image input depends on agy `view_file` / vision actually reading the staged path.
- Image output inlining is best-effort (path detection + 2MB cap); `generate_image` may be slow or gated.
- `usage_update.size` is a soft floor (200k).
- Structured `--json-schema` output may live only in agy’s `result.structured_output`; mapper may not surface it as ACP content yet (spawn + SUCCESS still verified).
- Third-party bridge — review Google ToS yourself. 第三方工程桥接，请自行评估 ToS。

## ToS note / 条款说明

Engineering feasibility ≠ legal permission. 即便只用官方 CLI I/O，仍可能受 ToS 约束。


## Bun + TypeScript / Windows

- Runtime is **Bun** (not Node). Entry: `bun src/server.ts` (or `bun run start`).
- Sources are TypeScript under `src/`; Bun runs `.ts` directly (no emit step).
- **Windows:** install [Bun](https://bun.sh), ensure `agy` is on `PATH`, then same commands (`bun src/server.ts`, `bun test`, `bun run smoke:all`).
- Unit tests: `bun test` (files `src/lib/*.test.ts`). Full live matrix: `bun run smoke:all`.
