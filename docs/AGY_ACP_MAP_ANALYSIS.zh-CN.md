# `agy-acp-map` 项目解析

> 本文基于仓库当前版本 `0.4.1` 的源码、README、测试和 smoke 文档整理。
> 重点分析项目的真实架构、协议边界、进程生命周期、富内容处理方式，以及它与
> PTY/SQLite 方案的差异。

## 一、先给结论

`yitom486-agy-acp-map` 的本质不是一个新的 Agent Runtime，也不是对
Antigravity 私有数据库的逆向读取器，而是一个相对轻量的第三方协议桥：

```text
ACP 客户端
    │  stdio + JSON-RPC NDJSON
    ▼
agy-acp-map / src/server.ts
    │  spawn 官方 agy CLI
    │  stdin/stdout + stream-json NDJSON
    ▼
agy CLI
```

它做的事情可以概括为：

1. 接收 ACP 客户端发来的 session 请求和 prompt；
2. 启动或复用普通的 `agy` CLI 子进程；
3. 通过 `--input-format stream-json` 向 `agy` 写入用户消息；
4. 读取 `agy --output-format stream-json` 的结构化事件；
5. 将 `init`、文本增量、工具调用、结果、usage 等事件转换成 ACP
   `session/update` 通知。

它明确选择了：

- **不读取 SQLite**；
- **不使用 PTY**；
- **不依赖 `agy_acp_server.exe`**；
- **不解析终端 ANSI 文本**；
- **不保存自己的会话数据库**；
- **不假装提供完整的 ACP 权限往返 UI**。

因此，它的设计方向比“启动交互式 CLI + 轮询私有 SQLite”更干净。代价是：
桥接进程本身的 session 只存在于内存中，取消、跨平台富内容、类型完整性和
异常进程管理还不够成熟。

---

## 二、项目定位与边界

### 2.1 它解决的具体问题

官方 `agy` CLI 可以使用 `stream-json` 输入/输出格式，但 ACP 客户端并不会
直接理解 `agy` 的事件格式。这个仓库填补的是协议转换层：

```text
ACP JSON-RPC 方法/通知
        ↓
内存中的 Session
        ↓
agy stream-json 用户事件
        ↓
agy stream-json 事件
        ↓
ACP session/update
```

从工程角度看，它同时承担三个职责：

| 职责 | 主要实现 |
|---|---|
| ACP stdio JSON-RPC 入口 | `src/server.ts` |
| `agy` 子进程启动、复用和终止 | `src/server.ts`、`src/lib/agy-args.ts` |
| `agy` 事件到 ACP update 的映射 | `src/lib/map-agy-to-acp.ts` |
| ACP 富内容转换为文件路径 | `src/lib/prompt-normalize.ts` |
| 输出图片路径转换为 ACP image block | `src/lib/rich-content.ts` |
| 无交互权限拒绝的提示 | `src/lib/soft-deny.ts` |
| 模型和 agent 发现 | `src/lib/agy-discovery.ts` |

### 2.2 它不负责什么

以下能力不在当前项目的职责范围内：

- 不读取 `~/.agy` 或 Antigravity 的内部 SQLite 数据库；
- 不保存自己的 transcript、历史记录或审计日志；
- 不在桥接进程重启后自动恢复内存 session；
- 不实现 ACP 原生 permission request/response 往返；
- 不提供 ACP 客户端文件系统服务；
- 不提供 ACP 客户端 terminal 服务；
- 不处理 `session/new` 中配置的 MCP server；
- 不包含 Zed 插件代码；
- 不包含 Google 官方 ACP Server 实现。

所以，项目 README 中的 `resume: true` 必须正确理解为：

> 已知 `conversationId` 时，重新启动 `agy` 可以通过
> `--conversation <id>` 恢复 agy 侧上下文。

它不是：

> 桥接进程崩溃后，桥接器可以自动恢复旧的 ACP session、transcript 和 UI 状态。

---

## 三、运行时和依赖结构

### 3.1 Runtime

`package.json` 指定：

```json
{
  "engines": {
    "bun": ">=1.1.0"
  }
}
```

启动方式是：

```bash
bun src/server.ts
```

项目代码使用了 Node 兼容内置模块，例如：

- `node:child_process`
- `node:readline`
- `node:fs`
- `node:path`
- `node:crypto`
- `node:url`

但运行时定位仍然是 **Bun**，不是 Node.js。它的 `bin` 字段虽然指向
`./src/server.ts`，实际仍需要 Bun 来执行 TypeScript：

```json
"bin": {
  "agy-acp": "./src/server.ts"
}
```

### 3.2 依赖特点

这个项目没有：

- `better-sqlite3`；
- `node-pty`；
- PyInstaller；
- Python 运行时；
- 原生数据库 addon。

运行时依赖基本是 Bun/Node 内置 API，只有 `bun-types` 位于开发依赖中。这
带来了一个明显优点：部署面比较小，不需要为 SQLite 原生模块或 PTY 模块处理
额外的 ABI、编译器和平台兼容问题。

但它也意味着：

- 需要用户本机安装 Bun；
- 需要用户本机已有并已登录的 `agy`；
- 不是一个可以脱离 `agy` 单独运行的 Agent；
- 当前并没有把 `agy` 二进制一起打包。

### 3.3 `agy` 的发现方式

默认二进制名是：

```text
agy
```

可用环境变量覆盖：

```text
AGY_BIN
```

例如 PowerShell：

```powershell
$env:AGY_BIN = 'C:\实际路径\agy.exe'
bun src/server.ts
```

这和另一些项目使用的 `AGY_BIN_PATH` 不是同一个变量，不能混用。

源码中的 `ensurePath()` 会额外尝试加入：

```text
/home/box/.local/bin
```

这是 Linux 环境路径。Windows 上主要还是依靠 `PATH` 或显式设置 `AGY_BIN`。

---

## 四、两层 NDJSON 协议

本项目最重要的设计，是没有把终端输出当成协议，而是使用两层结构化的
NDJSON。

### 4.1 外层：ACP stdio JSON-RPC

`src/server.ts` 使用 `readline` 逐行读取标准输入。每一行应该是一个完整的
JSON-RPC 对象，例如：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}
```

返回也逐行输出：

```json
{"jsonrpc":"2.0","id":1,"result":{}}
```

异步事件使用 ACP 通知：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "...",
    "update": {
      "sessionUpdate": "agent_message_chunk"
    }
  }
}
```

当前入口支持的主要方法包括：

| 方法 | 当前行为 |
|---|---|
| `initialize` | 发现模型/agent，返回 bridge capabilities |
| `session/new` | 创建内存 session，不立即启动 `agy` |
| `session/list` | 列出当前进程内的 session |
| `session/resume` | 只恢复当前进程内仍存在的 session 元数据 |
| `session/prompt` | 启动/复用 `agy` 并发送用户消息 |
| `session/cancel` | 尝试向子进程发送 `SIGINT` |
| `session/set_config_option` | idle 时修改启动配置，下一次 prompt 重启子进程 |
| `session/close` | 终止子进程并删除内存 session |

代码有 v1/v2 的初始化分支，但这并不等于完整通过 ACP v1/v2 conformance
测试。项目本身更准确的定位是一个 ACP-ish 的实用桥接器。

### 4.2 内层：`agy` stream-json

`spawnAgy()` 通过 pipe 启动 `agy`，基本参数由
`src/lib/agy-args.ts` 生成：

```text
agy -p "" \
  --input-format stream-json \
  --output-format stream-json \
  --print-timeout 0 \
  --add-dir <session.cwd>
```

根据 session 配置，可能继续追加：

```text
--conversation <id>
--model <model>
--effort <effort>
--mode <mode>
--agent <agent>
--sandbox
--json-schema <schema>
--dangerously-skip-permissions
--disable-slash-commands
--add-dir <directory>
```

发送给 `agy` 的每轮消息类似：

```json
{
  "event": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "请分析这个项目"
      }
    ]
  }
}
```

`agy` 的 stdout 每行是一个事件对象。当前 mapper 主要识别三类事件：

- `init`
- `step_update`
- `result`

stderr 不作为正常协议传递，但会：

1. 加上 `[agy stderr]` 前缀写到桥接器 stderr；
2. 保存到当前 session 的 `stderrBuf`；
3. 交给 soft-deny 解析器寻找权限拒绝信息。

### 4.3 为什么这个协议设计比 PTY 更干净

如果 `agy` 已经提供稳定的 `stream-json`，那么：

- 文本增量有明确字段；
- 工具调用有明确的 step 类型；
- 工具状态有 `ACTIVE`、`DONE`、`ERROR` 等边界；
- result 有明确的结束边界；
- usage 和 structured output 可以直接读取；
- 不需要剥离 ANSI 控制序列；
- 不需要模拟键盘输入或猜测终端提示符。

因此，当前项目在“将官方 CLI 接入 ACP”的目标下，选择 pipe + NDJSON 是合理
的，不是低级实现。

---

## 五、`agy` 事件如何映射到 ACP

核心代码位于 `src/lib/map-agy-to-acp.ts`。

### 5.1 `init`

收到 `init` 时，mapper 会记录：

- `conversation_id`；
- `init.tools`；
- `init.permission_mode`。

`init` 本身通常不会立即产生 ACP update。

### 5.2 `step_update.agent_response`

当事件形如：

```text
step_type = agent_response
text_delta = "..."
```

桥接器会产生：

```text
session/update
  └─ sessionUpdate: agent_message_chunk
```

同一个 `step_index` 会复用同一个 `messageId`，避免每个文本增量都创建一条
新的逻辑消息。

### 5.3 `step_update.tool`

工具事件会被转换成：

```text
sessionUpdate: tool_call_update
```

映射大致如下：

| `agy` 状态 | ACP 状态 |
|---|---|
| `ACTIVE` | `in_progress` |
| `DONE` 且无错误 | `completed` |
| `ERROR` 或存在 error | `failed` |

项目还会根据工具名猜测 ACP `kind`：

| 工具名特征 | 推断 kind |
|---|---|
| `run_command`、包含 `command` | `execute` |
| `view_file`、`grep_search`、`list_dir` | `read`/`search` |
| `write_to_file`、`replace_*` | `edit` |
| 包含 `delete` | `delete` |
| 其他 | `other` |

这里的 `kind` 是适配层推断值，不是 `agy` 官方传来的 ACP 原生字段。

### 5.4 `result`

收到 result 后，mapper 会：

- 更新 `conversationId`；
- 将 `usage.total_tokens` 转为 `usage_update`；
- 将 `structured_output` 转为 fenced JSON 文本，并在 `_meta` 中保留原对象；
- 判断 stop reason；
- 发出最终的 `state_update(state=idle)`。

当前规则：

```text
status === SUCCESS  → end_turn
status === REFUSAL  → refusal
错误文本包含 refus  → refusal
其他失败状态        → end_turn
```

有一个需要注意的行为：`result.response` 会用于图片路径探测，但不会作为普通
文本再次发送给 ACP。正常情况下项目依赖前面的
`agent_response.text_delta` 提供文本；如果某个版本的 `agy` 只返回
`result.response` 而没有文本增量，可能出现最终普通文本缺失的问题。

此外，`usage_update.size` 使用了：

```ts
Math.max(200_000, usage.total_tokens)
```

这只是一个 soft floor，不是真实上下文窗口大小。

---

## 六、Session 和子进程生命周期

### 6.1 Session 的存储模型

核心容器是：

```ts
const sessions = new Map();
```

每个 session 大致包含：

- `sessionId`；
- `cwd`；
- `additionalDirectories`；
- `child`；
- mapper 状态；
- `busy` / `cancelled`；
- `stderrBuf`；
- soft-deny 列表；
- `conversationId`；
- model、effort、mode、agent、sandbox 等配置；
- 创建和更新时间。

这意味着所有 session 状态都是进程内存对象，没有桥接层数据库。

### 6.2 正常流程

```text
session/new
    │
    │ 只创建内存 Session，不启动 agy
    ▼
session/prompt
    │
    ├─ 将 ACP ContentBlock 转成文本
    ├─ 如有图片/二进制内容，写入 staging 文件
    ├─ 发 user_message + running update
    ├─ 第一次 prompt 时启动 agy
    └─ 写入一行 stream-json user 事件
    ▼
agy 持续产生事件
    │
    ├─ 文本 → agent_message_chunk
    ├─ 工具 → tool_call_update
    └─ result → usage/structured output/idle
    ▼
下一轮 prompt 复用同一个 agy 子进程
```

项目的设计是 **persistent stdin stream**：一次 session 在正常完成一轮后，
子进程不会自动关闭，下一轮继续向同一个 stdin 写入 user event。

### 6.3 `conversationId` 恢复

当 mapper 从 `init` 或 `result` 中读到 conversation ID 后，会保存到 session。
之后因为取消、配置修改或子进程崩溃而重新 spawn 时，如果 ID 仍然存在，会
增加：

```text
--conversation <id>
```

这使得 agy 可以尝试恢复自己的上下文。

真正的边界是：

- bridge 自己没有持久化 `sessionId`；
- bridge 重启后 `sessions` Map 会丢失；
- `session/resume` 不能从数据库重新加载 session；
- bridge 不保存 transcript；
- 如果客户端自己保存 conversation ID，可以重新 `session/new` 并传回该 ID；
- 如果 conversation ID 尚未产生，崩溃后没有可用于恢复的 ID。

所以这里是“agy conversation 恢复”，不是“ACP bridge 完整恢复”。

### 6.4 取消实现的实际边界

`BRIDGE_CAPABILITIES` 宣称：

```text
cancelMode: SIGINT_then_KILL
```

但当前代码的 `handleSessionCancel()` 实际只直接执行：

```ts
session.child.kill('SIGINT');
```

`killAgy()` 中确实存在两秒后尝试 `SIGKILL` 的代码，但它有两个风险：

1. 普通 `session/cancel` 没有调用 `killAgy()`；
2. fallback 依赖 `!child.killed`，而在 Node/Bun 的 ChildProcess 语义中，
   `killed` 通常表示是否已经调用过 `kill()`，不一定表示操作系统进程已经
   退出，因此这个判断不能作为可靠的“进程仍然存活”判断。

配置变更和 close 路径还会在发送终止信号后立即修改 session 状态，可能导致：

- 旧子进程尚未退出；
- 新 prompt 已经启动新的子进程；
- 短时间内出现旧 child 和新 child 重叠；
- 旧 child 的迟到事件和新 turn 状态交叉。

这不代表正常场景一定会失败，但它说明当前取消并不是生产级的进程监督器。

### 6.5 其他生命周期风险

`spawnAgy()` 没有注册明确的 `child.on('error')` 处理器。若 `agy` 不存在、
路径错误或子进程启动失败，底层错误不一定会稳定转换为 ACP 错误响应。

`session/close` 会先调用 kill，然后立即从 Map 删除 session，不等待 child 真正
退出。如果 child 的 exit handler 后续仍然执行，理论上可能在 close 之后写出迟到的
update。

---

## 七、启动参数、模型发现和安全模式

### 7.1 支持的启动配置

| `agy` 参数 | ACP/session 字段 | 环境变量兜底 |
|---|---|---|
| `--model` | `model` | `AGY_ACP_MODEL` |
| `--effort` | `effort` | `AGY_ACP_EFFORT` |
| `--mode` | `mode` | `AGY_ACP_MODE` |
| `--agent` | `agent` | `AGY_ACP_AGENT` |
| `--sandbox` | `sandbox: true` | `AGY_ACP_SANDBOX=1` |
| `--json-schema` | `jsonSchema` | `AGY_ACP_JSON_SCHEMA` |
| `--conversation` | `conversationId` | 由上一次 turn 得到 |
| `--dangerously-skip-permissions` | `safety`/`skipPermissions` | `AGY_ACP_SAFETY` / `AGY_ACP_SKIP_PERMISSIONS` |
| `--disable-slash-commands` | `disableSlashCommands` | `AGY_ACP_DISABLE_SLASH_COMMANDS` |
| `--print-timeout` | `printTimeout` | `AGY_ACP_PRINT_TIMEOUT` |

配置可以来自：

1. `session/new` 顶层字段；
2. `_meta`；
3. `config`；
4. 环境变量；
5. `configOptions`。

`configOptions` 会在解析后继续应用，因此实际使用时应避免同一个选项在多个
位置重复设置，以免产生覆盖关系上的误解。

### 7.2 safe 与 autonomous

默认模式是 `safe`：

```text
不传 --dangerously-skip-permissions
```

`autonomous` 模式会：

```text
传 --dangerously-skip-permissions
```

如果没有显式设置 sandbox，它还会默认增加：

```text
--sandbox
```

需要注意，`safe` 并不等于提供了 ACP 的交互式权限弹窗。当前桥接器没有权限
round-trip UI。它的处理方式是让 agy 在 headless 模式下拒绝工具，然后从 stderr
或 stream-json 事件中解析可能的 allow rule，最后发一条提示消息。

### 7.3 soft-deny 的工作方式

`src/lib/soft-deny.ts` 会尝试识别：

- `required the "command" permission ... auto-denied`；
- `allow-rule=...`；
- `permission check failed`；
- tool `ERROR`；
- `result.denied_actions`。

然后生成类似的提示：

```text
Headless soft-deny: one or more tools were auto-denied (no interactive permission UI).
Suggested settings.json permissions.allow rules:
- tool=run_command allow-rule=command(<target>)
```

这是一种“无 UI 兼容策略”，不是完整权限系统。它还有两个潜在问题：

- stderr 解析依赖固定的英文文本；
- `parseSoftDenyFromEvent()` 对一般的 tool `ERROR` 也可能推断成权限拒绝，
  因而存在误报风险。

### 7.4 initialize 的发现行为

`initialize` 会调用：

```text
agy models
agy agents
```

如果 `agy agents` 失败，还会尝试：

```text
agy agent
```

每个短命令默认超时 10 秒，结果按桥接进程生命周期缓存。失败不会阻断
`initialize`，而是返回空数组和 discovery note。

因为这些调用是顺序执行的，若多次超时，实际初始化等待时间可能接近多个
10 秒 timeout 的总和，而不是严格只有 10 秒。

---

## 八、富内容：为什么要经过 staging 文件

### 8.1 输入方向：ACP 富内容 → 文件路径 + 文本

`agy` 的 stream-json stdin 当前按文本输入使用。项目没有把 ACP 的图片或二进制
内容直接作为 `agy` 的 content block 传递，而是：

1. 将 base64 或 data URL 解码；
2. 写到 `<cwd>/.agy-acp-staging/`；
3. 在用户文本中注入文件路径；
4. 提示 agent 使用 `view_file` 或其他能力读取该文件。

示例文本：

```text
User attached an image file at: C:\project\.agy-acp-staging\<uuid>.png
Please open/view that file and answer based on what you see.
```

支持的输入包括：

- 普通 text；
- `resource.text`；
- `resource.blob`；
- image data/base64；
- image file URI；
- audio data/base64；
- audio `file://` URI；
- `resource_link` 会退化成文本链接。

`--add-dir <cwd>` 会覆盖 cwd 下的 staging 目录，因此 agy 可以访问这些文件。

### 8.2 staging 的磁盘生命周期问题

当前实现会创建 staging 目录和文件，但没有看到按 turn、按 session 或按退出时
清理已写入文件的逻辑。结果是：

- 每次发送图片、音频或二进制 resource 都可能新增文件；
- 长期使用可能造成项目目录增长；
- 文件可能包含敏感图片、音频或资源内容；
- 即使普通文本 prompt，sync normalize 路径也会先确保 staging 目录存在。

另外，输入二进制没有明确的大小上限，过大的 base64 可能同时造成内存和磁盘
压力。这是当前项目中最接近“磁盘泄露/无限增长”的实际问题，但它与
PyInstaller `_MEI` 临时目录问题不同：这里是桥接器主动生成的业务 staging 文件，
不是启动解包目录。

### 8.3 输出方向：图片路径 → ACP image block

`src/lib/rich-content.ts` 会从以下内容中寻找图片路径：

- tool 文本输出；
- tool 参数；
- tool output；
- 最终 response 文本。

若文件存在、扩展名受支持且不超过 2 MiB，就读取并转成：

```json
{
  "type": "image",
  "mimeType": "image/png",
  "data": "<base64>",
  "uri": "file:///..."
}
```

支持的后缀包括：

```text
png jpg jpeg webp gif bmp svg
```

超过 2 MiB、文件不存在或不可读时，通常只保留路径文本。

### 8.4 Windows 路径支持（本次已修复）

此前 `PATH_RE` 主要覆盖 Unix 风格的 `/...`、`./...`、`../...` 路径。当输出
类似下面的内容时：

```text
saved to D:\...\fixtures\tiny.png
```

旧实现会把包含 `saved to` 的整段文本当成路径，导致图片无法内联。

本次修改 `src/lib/rich-content.ts` 后：

- 增加 Windows drive-letter 路径，例如 `C:\images\result.png`；
- 增加 UNC 路径，例如 `\\server\share\result.png`；
- 支持 `file:///C:/images/result.png` 形式的 Windows 文件 URI；
- 只把真正的 path-like 字符串当成完整路径，避免把普通句子当路径；
- 使用 `pathToFileURL()` 生成标准的 `file:///C:/...` 输出 URI；
- 增加 Windows 盘符、UNC 和 file URI 回归测试。

当前 Windows + Bun 环境重新运行：

```bash
bun test src/lib
```

结果为：

```text
55 pass
0 fail
```

仍然存在的边界是：输出图片读取没有把路径限制在 session `cwd`、staging 目录或
`additionalDirectories` 内。如果 agent/tool 输出了当前进程有权限读取的任意图片
路径，桥接器可能把它读入并发送给 ACP 客户端，仍存在文件内容越权暴露的可能性。

---

## 九、文件职责地图

| 文件 | 作用 | 评价 |
|---|---|---|
| `src/server.ts` | ACP stdio 入口、session 管理、子进程生命周期 | 核心编排文件，职责较多 |
| `src/map.ts` | 离线读取 NDJSON 并展示 mapper 结果 | 便于调试映射，不启动真实 agy |
| `src/lib/agy-args.ts` | 配置归一化、环境变量、启动参数构造 | 纯函数较多，适合单测 |
| `src/lib/agy-discovery.ts` | `agy models`/`agy agents` 运行和解析 | 有缓存和 timeout |
| `src/lib/map-agy-to-acp.ts` | agy event → ACP update | 协议核心，含状态机雏形 |
| `src/lib/prompt-normalize.ts` | 富输入 staging 和文本 flatten | 会产生磁盘文件，当前缺清理 |
| `src/lib/rich-content.ts` | 图片路径识别、文件读取、ACP image block | 已补齐 Windows 路径与 file URI 测试 |
| `src/lib/soft-deny.ts` | stderr/event 权限拒绝解析 | 实用但依赖英文模式，可能误报 |
| `src/client-smoke*.ts` | live smoke 客户端 | 覆盖面不错，但部分断言较宽松 |
| `src/lib/*.test.ts` | 纯单元测试 | 不覆盖完整 child 生命周期 |
| `sample_success.ndjson` | mapper 离线样例 | 便于回归协议映射 |
| `SMOKE_*.md` | 历史 smoke 报告 | 需结合当前平台重新验证 |
| `TEST_MATRIX.md` | 测试矩阵说明 | live smoke 仍需在目标平台重新验证 |

---

## 十、测试与当前验证结果

### 10.1 当前环境实际运行结果

本次在 Windows + Bun `1.3.14` 环境中运行：

```bash
bun test src/lib
```

结果：

```text
55 pass
0 fail
```

本次结果包含新增的 Windows 盘符、UNC 路径和 file URI 回归测试。

运行：

```bash
bun run test:args
```

结果：

```text
15 checks passed
```

运行：

```bash
bunx tsc --noEmit
```

结果：

```text
Found 317 errors in 13 files.
```

这些错误主要来自：

- `strict`/`noImplicitAny` 下大量未标注类型；
- smoke 脚本中的 `unknown` 和隐式 `any`；
- `server.ts` 的 `replyError` 参数和异常类型；
- mapper、prompt normalize、rich content、soft-deny 的类型不完整。

因此，“Bun 可以直接运行 TypeScript”不等于“严格 TypeScript 检查通过”。

### 10.2 已覆盖的功能

单元测试已经覆盖：

- `buildAgyArgs`；
- safe/autonomous 权限参数；
- model、effort、mode、agent、sandbox；
- conversation 参数；
- `init`、文本增量、工具、result 映射；
- structured output；
- prompt 文本 flatten；
- image/resource staging；
- 图片路径和 base64 输出；
- soft-deny 解析；
- models/agents 输出解析。

### 10.3 覆盖不足的部分

以下内容不能仅靠现有单元测试证明可靠：

1. `agy` 不存在或启动失败时的行为；
2. stdin EPIPE、stdout 关闭、stderr 延迟；
3. SIGINT 无效时是否一定能 SIGKILL；
4. cancel、close、set_config 和 result 同时发生时的竞态；
5. 旧 child 的迟到事件是否影响新 turn；
6. 多 session 并发；
7. bridge 重启后的 session 恢复；
8. Windows drive path 和 Windows `file://` URI；
9. staging 清理和超大 base64；
10. 普通 tool error 与 permission deny 的区分；
11. 只有 `result.response`、没有文本 delta 的 agy 输出；
12. 完整 ACP v1/v2 conformance。

历史 `SMOKE_*.md` 记录了 Linux 环境下的 live smoke，但这些报告不应当直接
当作当前 Windows 行为的证明。尤其是图片输出、信号、路径和 Bun/Node 兼容性，
都需要在目标平台重新运行。

本次没有运行 live smoke，因为它需要本机可用、已登录的 `agy` CLI。

---

## 十一、与 PTY + SQLite 方案的比较

`agy-acp-map` 与一些使用 PTY、轮询私有 SQLite、解析 protobuf 的方案不是同一
种取舍。

| 维度 | 当前 `agy-acp-map` | PTY + 私有 SQLite 方案 |
|---|---|---|
| CLI 连接 | pipe + stream-json | PTY 启动交互式 CLI |
| 事件来源 | 官方结构化 NDJSON | 终端行为 + 私有数据库记录 |
| 工具状态 | 直接读取事件字段 | 需要终端/数据库组合推断 |
| 会话上下文 | 通过 `--conversation` 让 agy 自己恢复 | 读取或依赖 agy 内部 conversation DB |
| bridge 持久化 | 无 | 通常可查询内部数据库 |
| SQLite 依赖 | 无 | 常见 `better-sqlite3`/SQLite 读取 |
| 对 agy 私有 schema 的耦合 | 低，主要依赖 CLI stream-json 契约 | 高，依赖表结构、WAL、protobuf schema |
| 终端兼容复杂度 | 较低 | PTY、ANSI、进程组、权限提示更复杂 |
| 跨平台风险 | 主要是路径和信号 | PTY/信号/终端行为多重差异 |
| 重启恢复 | bridge session 不恢复，agy conversation 可恢复 | 更容易做历史查询，但受内部格式变化影响 |
| 隐私复制 | 不主动读取内部历史数据库 | 可能复制/读取更多内部会话数据 |

### 11.1 为什么当前方案更适合 ACP 主链路

只要 `agy --output-format stream-json` 能提供足够完整的事件，当前方案更适合
做 ACP 适配，因为：

- ACP 本身也是结构化消息协议；
- stream-json 有自然的行边界；
- 不需要把终端画面重新解释成事件；
- 不需要使用 SQLite 充当实时消息总线；
- 不会因为 agy 私有数据库 schema 变化而立即失效；
- 不会把内部数据库当成官方公共 API。

### 11.2 当前方案的牺牲

它放弃了：

- bridge 自己的长期历史列表；
- bridge 进程重启后的 session metadata；
- 完整 transcript replay；
- ACP permission round-trip；
- 对 agy 内部历史数据的直接查询。

如果未来要补持久化，优先考虑新增一个**自己拥有 schema 的小型持久化层**，
而不是直接依赖 agy 私有 SQLite。持久化层可以只保存：

- ACP session 元数据；
- `conversationId`；
- cwd 和启动配置；
- 必要的桥接状态。

不一定需要复制整个 agy transcript。

### 11.3 与 PTY 的正确关系

PTY 和 SQLite 其实解决不同问题：

- PTY 解决交互式终端传输；
- SQLite 解决持久化和查询。

可以有：

```text
PTY + SQLite
```

也可以有：

```text
stream-json pipe + SQLite
```

当前项目选择的是：

```text
stream-json pipe + agy 自己的 conversation 恢复 + bridge 不持久化
```

这是一个明确的轻量化取舍，不应简单评价为“实现低级”。更准确的评价是：
协议主链路选择较好，但 session 服务化和跨平台工程细节仍不完整。

---

## 十二、建议的改进优先级

以下是基于当前源码的工程建议，不代表本次已经修改。

### P0：先修会导致不稳定或数据风险的问题

1. **处理 child 的 `error` 事件**
   - `agy` 不存在、路径错误时，应转换成可预测的 ACP 错误/idle 状态；
   - 不应依赖未处理的 EventEmitter error。

2. **重做取消和子进程监督**
   - cancel 统一走一个 kill 流程；
   - 记录 child generation 或 turn ID；
   - 等待退出；
   - 超时后明确执行平台兼容的强制终止；
   - 新 child 启动前确认旧 child 已退出。

3. **限制输出图片可读取范围**
   - Windows 盘符、UNC 和 file URI 识别已补齐；
   - 仍应限制在 session `cwd`、staging 目录和 additionalDirectories；
   - 相对路径应基于 session `cwd`，而不是隐含使用当前进程 cwd；
   - 同时处理路径规范化和符号链接边界。

4. **给 staging 增加大小限制和清理策略**
   - 限制单个 blob 和单轮总大小；
   - turn 完成后按策略清理；
   - session close 或 server shutdown 时清理；
   - 对需要保留的文件提供显式配置，而不是永久残留。

### P1：提高协议和跨平台正确性

1. 将 `result.response` 作为没有 text delta 时的 fallback；
2. 增加 `CANCELLED`、未知状态和异常 result 的明确映射；
3. 修正 soft-deny 对一般 tool error 的误报；
4. 给每个 child/turn 增加 generation token，忽略旧进程迟到事件；
5. 严格校验 `cwd` 和 `additionalDirectories` 是否存在、是否可访问；
6. 为 Windows 添加真实 live smoke，而不是只运行 Linux 历史报告；
7. 统一 `AGY_BIN`、文档和上层项目的路径配置命名。

### P2：提高长期可维护性

1. 补齐 `strict` TypeScript 类型，先让核心 `server.ts` 和 `src/lib` 通过
   `tsc --noEmit`；
2. 将 child lifecycle 从 `server.ts` 拆成独立的 process manager；
3. 给 ACP 输入、agy 输出和 mapper 建立明确的 discriminated union 类型；
4. 增加协议 fixture：乱序、重复、截断、空字段、只有 result.response；
5. 如果需要跨重启管理，再增加自有 schema 的轻量 session store；
6. 将 smoke 脚本的 `PARTIAL` 和永真断言改成严格失败。

---

## 十三、最终评价

从架构方向看，这个项目做了一个正确的取舍：

> 优先使用官方 CLI 暴露的结构化 stream-json，而不是模拟终端、轮询私有
> SQLite 或依赖 PyInstaller ACP Server 的临时解包行为。

它的优点是：

- 依赖少；
- 协议边界清楚；
- 不绑定 agy 私有 SQLite schema；
- 不需要 PTY；
- 工具、文本和 result 能结构化映射；
- 启动参数和安全模式有一定可配置性；
- 通过 `conversationId` 可以利用 agy 自己的上下文恢复能力。

它的不足是：

- session 只在内存中存在；
- 取消和旧 child 管理不够可靠；
- spawn error 处理不完整；
- staging 文件没有清理机制；
- Windows 盘符、UNC 和 file URI 路径问题已修复并加入回归测试，但输出路径 allowlist 仍需补充；
- 严格 TypeScript 检查尚未通过；
- ACP 权限 UI、history replay 和完整跨进程恢复都没有实现。

所以比较准确的定位是：

> 这是一个思路清晰、主链路合理的轻量 ACP bridge，适合验证和实际接入
> 官方 `agy` CLI；但当前还不能把它当成已经完成的、生产级、跨平台 ACP
> session 服务。

如果使用场景只是“让 ACP 客户端调用本机已经安装并登录的 `agy`”，它比
PTY + 私有 SQLite 方案更值得优先尝试。如果目标是 IDE 级别的长期 session
管理、跨重启恢复、审计和完整权限交互，则还需要在它之上补进程监督、持久化、
权限协议和跨平台测试，而不是回到读取 agy 私有数据库这条高耦合路线。
