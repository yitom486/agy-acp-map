# agy-acp-map — ACP v2 ↔ agy stream-json bridge (v0.1.2 · Bun + TypeScript)

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
                                      ├─ src/lib/agy-process.ts       (spawn/kill/generation)
                                      ├─ src/lib/agy-args.ts          (buildAgyArgs / safety / printTimeout)
                                      ├─ src/lib/agy-discovery.ts     (agy models / agents)
                                      ├─ src/lib/prompt-normalize.ts  (image → files + size/cleanup)
                                      ├─ src/lib/rich-content.ts      (paths → ACP image + allowlist)
                                      ├─ src/lib/path-allowlist.ts    (session root checks)
                                      ├─ src/lib/soft-deny.ts         (stderr soft-deny)
                                      └─ src/lib/session-store.ts     (disk id/config index)
```

- **No SQLite / no `~/.agy` DB reads**: never opens agy conversation stores.
- **Lightweight SessionStore** (`~/.agy-acp-map/sessions.json`): ACP `sessionId` ↔ agy `conversationId` + launch snapshot only. **Not** a transcript DB.
- **Client owns transcript** (e.g. zustand / gateway UI). Bridge advertises `historyReplay: false`.
- **No Zed / Antigravity plugin code**.
- **Persistent stdin stream-json** (same child across turns until cancel/config change).
- **Resume:** `session/resume` rehydrates from memory or disk; next prompt respawns with `--conversation <id>` + saved flags. No history replay via `session/update`.

## Requirements / 环境

- Bun ≥ 1.1 (tested 1.4.2) + TypeScript sources under `src/`
- `agy` on PATH (`export PATH="/home/box/.local/bin:$PATH"`) and logged in

## Run / 运行

```bash
export PATH="/home/box/.local/bin:$PATH"
cd /workspace/agy-acp-map

bun src/server.ts                 # ACP stdio agent
bun test                          # unit tests
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


## Launch flags / 启动参数 (v0.1.2)

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
| `--dangerously-skip-permissions` | `safety: 'autonomous' \| 'autonomous-unsandboxed'` or `skipPermissions: true` | `AGY_ACP_SAFETY=…` / `AGY_ACP_SKIP_PERMISSIONS=1` if safety unset (**default off / safe**) |
| `--disable-slash-commands` | `disableSlashCommands` (default **true**) | `AGY_ACP_DISABLE_SLASH_COMMANDS=0` to omit |
| `--print-timeout` | `printTimeout` (e.g. `30m`, `120s`, `0`) | `AGY_ACP_PRINT_TIMEOUT` (default `0`) |

Also accepts a simple ACP-ish `configOptions: [{ id|configId, value }, ...]` including `printTimeout`, `safety`, `disableSlashCommands`.

Invalid model / effort values fail **loud** at agy spawn (stderr + turn ends); the bridge does not validate catalog ids.

无效的 model/effort 会在 agy 启动时失败（stderr 可见）；桥接层不做模型目录校验。

### Session store / 会话索引 (v0.1.2)

**What is stored / 存什么**

| Field | Meaning |
|-------|---------|
| `sessionId` | ACP id minted by this bridge |
| `conversationId` | agy conversation id when known |
| `title`, `cwd`, `additionalDirectories` | display / workspace |
| `model`, `effort`, `mode`, `agent`, `safety`, `sandbox`, `jsonSchema`, `printTimeout`, `disableSlashCommands` | launch snapshot for respawn |
| `createdAt`, `updatedAt` | ISO timestamps |

**What is NOT stored / 不存什么**

- Messages, tool traces, NDJSON event logs, images, or any full transcript
- Client UI state — **zustand / ACP Client owns the transcript**

Default path: `~/.agy-acp-map/sessions.json`. Override with `AGY_ACP_STORE` or `AGY_ACP_SESSION_STORE`.

默认路径：`~/.agy-acp-map/sessions.json`；可用 `AGY_ACP_STORE` / `AGY_ACP_SESSION_STORE` 覆盖。

### Resume vs load / 恢复 vs 加载

| | `session/resume` (this bridge) | History load / replay |
|--|-------------------------------|------------------------|
| Purpose | Re-attach ACP `sessionId` → memory + spawn with `--conversation` | Stream past turns into UI |
| Bridge behavior | Rehydrate id/config from memory or **disk store**; **no** `session/update` history | **Not implemented** (`historyReplay: false`) |
| Who has messages | Client already has them (or reloads from its own store) | Would be Agent → Client replay |

中文：`session/resume` 只恢复 id/配置映射并在下次 prompt 带 `--conversation` 拉起 agy；**不会**通过 `session/update` 重放历史。完整对话记录由 Client（如 zustand）持有。不实现 `session/load` 式 history replay。

### Resume & dynamic config / 恢复与动态配置

1. **First spawn** of a brand-new session: omit `--conversation`; `session/new` upserts disk store immediately.
2. Mapper learns `conversation_id` from agy `init`/`result` → `session.conversationId` + store upsert.
3. Exported in `session/new` / `session/resume` `_meta`, and `session/list` (`_meta.conversationId` when present). `session/list` merges memory + disk (**prefer memory**).
4. After cancel/kill/crash **respawn**: `--conversation <id>` so Agent-side context resumes.
5. After **close** or process restart: `session/resume` with stored `sessionId` rehydrates into memory (no child yet); next prompt spawns with saved flags + `--conversation`. Disk row kept on close unless `AGY_ACP_DELETE_ON_CLOSE=1`.
6. **Change model mid-life (recommended):** wait idle → `session/close` → `session/new` with `{ cwd, conversationId, model, ... }`.
7. **Or** idle `session/set_config_option`:
   ```json
   { "sessionId": "...", "configId": "model|effort|mode|agent|sandbox|jsonSchema|printTimeout|safety|disableSlashCommands", "value": "..." }
   ```
   Updates session fields, kills lingering child; **next** `session/prompt` respawns with new flags + `--conversation`. When busy → error `-32002`.

`bridgeCapabilities.dynamicConfig: "restart"` · `resume: true` · `historyReplay: false`.

## Env / 环境变量

| Env | Default | Meaning |
|-----|---------|---------|
| `AGY_ACP_SAFETY` | `safe` | `safe` \| `autonomous` \| `autonomous-unsandboxed` (aliases: `unsandboxed`, `autonomous_unsandboxed`). See Safety modes table. |
| `AGY_ACP_SKIP_PERMISSIONS` | `0` | If **safety unset**: `1` ≈ treat as `autonomous`; `0` ≈ `safe`. Explicit `AGY_ACP_SAFETY` / `session.safety` wins. |
| `AGY_ACP_DISABLE_SLASH_COMMANDS` | `1` | When `1` (default), pass `--disable-slash-commands`. Set `0` to omit. |
| `AGY_ACP_PRINT_TIMEOUT` | `0` | Passed as `--print-timeout` (e.g. `30m`, `120s`, `0` = wait until turn completes). |
| `AGY_BIN` | `agy` | Override binary |
| `AGY_ACP_MODEL` | — | Default `--model` |
| `AGY_ACP_EFFORT` | — | Default `--effort` |
| `AGY_ACP_MODE` | — | Default `--mode` |
| `AGY_ACP_AGENT` | — | Default `--agent` |
| `AGY_ACP_SANDBOX` | — | `1`/`0` → force sandbox on/off for `safe`/`autonomous`. Ignored for `autonomous-unsandboxed` (never sandboxed). |
| `AGY_ACP_JSON_SCHEMA` | — | Schema string or file path for `--json-schema` |
| `AGY_ACP_KEEP_STAGING` | — | `1` → keep `.agy-acp-staging` files after turn/close (debug) |
| `AGY_ACP_STORE` / `AGY_ACP_SESSION_STORE` | `~/.agy-acp-map/sessions.json` | Disk session index path (`SESSION_STORE` wins if both set) |
| `AGY_ACP_DELETE_ON_CLOSE` | unset | `1`/`true` → also delete store row on `session/close` (default: **keep** disk for resume) |

## `initialize` → bridgeCapabilities

Returned alongside standard ACP fields (also under `_meta.bridgeCapabilities`):

| Field | Value | Notes |
|-------|-------|-------|
| `prompt` | `true` | |
| `streaming` | `true` | |
| `tools` | `true` | Mapped from agy tool steps |
| `resume` | `true` | Disk/memory SessionStore; respawn passes `--conversation` |
| `permissionRoundTrip` | `false` | No ACP permission UI |
| `permissionMode` | `safety_tiers` | Launch strategies only; no ACP permission UI |
| `safetyTiers` | `[safe, autonomous, autonomous-unsandboxed]` | See Safety modes table |
| `nativeCancel` | `false` | |
| `cancelMode` | `SIGINT_then_KILL` | |
| `historyReplay` | `false` | No Agent→Client history replay; Client owns transcript |
| `dynamicConfig` | `restart` | `session/new` + idle `set_config_option` / close+new |
| `richContentInput` | `degrade_to_files` | Images → `.agy-acp-staging/` + text path |
| `richContentOutput` | `best_effort` | Detect paths; inline base64 ≤2MB |
| `clientFilesystem` | `false` | |
| `clientTerminal` | `false` | |


On `initialize`, the bridge runs `agy models` and `agy agents` (≈10s timeout, cached for process lifetime). Results appear as `availableModels` / `availableAgents` on `bridgeCapabilities` and `_meta`, plus ACP-ish `configOptions`. Discovery failure → empty arrays (initialize still succeeds).

`initialize` 时会跑 `agy models` / `agy agents`（约 10s 超时，进程内缓存），结果挂在 `bridgeCapabilities.availableModels|availableAgents` 与 `configOptions`。失败则空数组，不阻断 initialize。

### Safety modes / 安全模式 (v0.1.1)

No interactive ACP permission UI — **launch strategies only** (`resolveSafety` → agy flags).

无交互式 ACP 权限 UI，仅启动策略（`resolveSafety` → agy 参数）。

| Mode / 模式 | Skip permissions / 跳过权限 | Sandbox / 沙箱 |
|-------------|------------------------------|----------------|
| **safe** (default) | no — rely on agy `settings.json` allow/deny + soft-deny messages | only if user sets `sandbox: true` / `AGY_ACP_SANDBOX=1` |
| **autonomous** | yes (`--dangerously-skip-permissions`) | **default `--sandbox`** unless user sets `sandbox: false` / `AGY_ACP_SANDBOX=0` |
| **autonomous-unsandboxed** (aliases: `autonomous_unsandboxed`, `unsandboxed`) | yes (`--dangerously-skip-permissions`) | **never** pass `--sandbox` (explicit dangerous tier; ignores sandbox overrides) |

Accept via:
- `session/new` field `safety`: `'safe' | 'autonomous' | 'autonomous-unsandboxed'`
- env `AGY_ACP_SAFETY` (same values)
- idle `session/set_config_option` with `configId: "safety"`
- Backward compat: `AGY_ACP_SKIP_PERMISSIONS=1` ≈ `autonomous` **if safety unset**; `=0` ≈ `safe`

输入：`session/new.safety` / `AGY_ACP_SAFETY` / `set_config_option`；兼容 `AGY_ACP_SKIP_PERMISSIONS`（仅在未设 safety 时生效）。

## Image / rich content strategy / 富内容策略

**Input:** agy stream-json stdin **rejects** non-text content blocks. The bridge stages `image` / binary `resource` / `audio` under `<cwd>/.agy-acp-staging/<uuid>.<ext>` and injects text like:

```
User attached an image file at: /abs/path.png
Please open/view that file and answer based on what you see.
```

`--add-dir <cwd>` covers the staging directory.

**Output:** When tools (especially `generate_image`) or agent text mention `png|jpg|webp|gif` paths, the mapper adds ACP `{ type: 'image', mimeType, data }` (base64) if the file exists, is ≤2MB, **and** resolves under session `cwd` / `.agy-acp-staging` / `additionalDirectories`; otherwise path text only.

## Soft-deny / 权限

Without skip-permissions, agy may stderr e.g.:

> a tool required the "command" permission … auto-denied. Add an allow-rule … (e.g. command(\<target\>))

`src/lib/soft-deny.ts` parses these; at turn end the server emits an `agent_message_chunk` listing suggested allow rules.

## Files / 文件

| File | Role |
|------|------|
| `src/server.ts` | ACP v2 stdio server |
| `src/lib/agy-process.ts` | Child spawn/kill/generation supervision |
| `src/lib/agy-args.ts` | `buildAgyArgs` / safety / printTimeout / slash |
| `src/lib/agy-discovery.ts` | `agy models` / `agy agents` parsers |
| `src/lib/map-agy-to-acp.ts` | agy event → ACP updates |
| `src/lib/prompt-normalize.ts` | ContentBlock → text + staging + size/cleanup |
| `src/lib/rich-content.ts` | Image path extract / ACP image block |
| `src/lib/path-allowlist.ts` | Session cwd/staging/add-dir allowlist |
| `src/lib/soft-deny.ts` | Stderr soft-deny parser |
| `src/lib/session-store.ts` | Disk session id/config index (atomic JSON) |
| `docs/AGY_ACP_MAP_ANALYSIS.zh-CN.md` | Architecture analysis (kept) |
| `src/test-agy-args.ts / `bun test`` | Unit tests (no live agy) |
| `src/client-smoke*.ts` | Smokes |
| `fixtures/tiny.png` | Blue “HI” PNG for image-in |
| `SMOKE_*.md` | Smoke reports |


## Opinion / 看法（v0.1.2）

Agree with the analysis: **stream-json > PTY/SQLite** for coupling. 0.1.0+ added process supervision, allowlists, staging cleanup; **0.1.2** adds the lightweight disk SessionStore (id mapping only — Client still owns transcript).

认同分析结论：stream-json 在耦合上优于 PTY/SQLite。0.1.0+ 已有进程监督、白名单、staging 清理；**0.1.2** 增加轻量磁盘 SessionStore（仅 id/配置映射，对话正文仍由 Client 持有）。

## Engineering baseline (0.1.0) / 工程基线

| Area | Change |
|------|--------|
| Child `error` | `child.on('error')` → ACP agent_message + idle `error`/`cancelled`; no unhandled EventEmitter errors |
| Process supervision | `src/lib/agy-process.ts`: generation tokens, SIGINT→SIGTERM→force kill (Windows `taskkill`), await old exit before respawn, ignore stale NDJSON |
| Image allowlist | `fileToAcpImageBlock` only reads under session `cwd` / staging / `additionalDirectories` (realpath; relative → session cwd) |
| Staging | Max 8MB/blob, 32MB/turn; cleanup after idle / session close / shutdown; `AGY_ACP_KEEP_STAGING=1` to keep |
| Mapper | `result.response` fallback when no `text_delta`; `CANCELLED`/`INTERRUPTED` → `stopReason: cancelled` |
| Soft-deny | Generic tool ERROR no longer treated as permission deny |
| session/new | Reject missing / non-directory `cwd` |

See also `docs/AGY_ACP_MAP_ANALYSIS.zh-CN.md` (analysis kept; P0 items addressed in this release).

## Session store engineering (0.1.2) / 会话存储工程

| Area | Behavior |
|------|----------|
| Atomic write | Write `.<name>.<pid>.<ts>.tmp` then `rename` into place |
| `session/list` | Union of memory + disk; **memory wins** on same `sessionId` |
| `session/resume` | Memory hit → existing behavior; disk-only → rehydrate Session (no child); unknown → JSON-RPC `-32001` |
| `session/close` | Kill child, drop memory; **keep** disk row (unless `AGY_ACP_DELETE_ON_CLOSE=1`) |
| History | Never emits past turns on resume |

## Non-goals / 明确不做

- **OneShot `-p` backend**: not planned. Continuous ACP sessions use persistent `stream-json` only. Use the `agy` CLI directly for one-off CI/`-p` scripts.
- **OneShot `-p` 后端**：不做。ACP 连续会话只走常驻 `stream-json`；一次性脚本请直接用 `agy -p`。
- **Interactive ACP permission round-trip**：CLI stream-json 不支持；用 safety 三档 + settings allow。
- **History replay / `session/load` 重放**：不把全文存 bridge；Client（zustand/Zed）自管 transcript，bridge 只做 id 级 `resume`。

## Limitations / 限制

- MCP servers from `session/new` ignored (agy has its own).
- No ACP permission round-trip UI (`permissionRoundTrip: false`).
- Cancel = SIGINT then SIGKILL (no mid-turn stream cancel API).
- No history replay (`historyReplay: false`). Client / zustand owns transcript; store is id+config only.
- Image input depends on agy `view_file` / vision actually reading the staged path.
- Image output inlining is best-effort (path detection + 2MB cap); `generate_image` may be slow or gated.
- `usage_update.size` is a soft floor (200k).
- Structured `--json-schema` output: mapper surfaces `result.structured_output` as a fenced JSON `agent_message_chunk` plus `_meta.structuredOutput`.
- Third-party bridge — review Google ToS yourself. 第三方工程桥接，请自行评估 ToS。

## ToS note / 条款说明

Engineering feasibility ≠ legal permission. 即便只用官方 CLI I/O，仍可能受 ToS 约束。


## Bun + TypeScript / Windows

- Runtime is **Bun** (not Node). Entry: `bun src/server.ts` (or `bun run start`).
- Sources are TypeScript under `src/`; Bun runs `.ts` directly (no emit step).
- **Windows:** install [Bun](https://bun.sh), ensure `agy` is on `PATH`, then same commands (`bun src/server.ts`, `bun test`, `bun run smoke:all`).
- Unit tests: `bun test` (files `src/lib/*.test.ts`). Full live matrix: `bun run smoke:all`.
