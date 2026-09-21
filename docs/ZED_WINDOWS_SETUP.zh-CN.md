# Zed on Windows 无黑框配置（定稿）

> 适用：`@yitom/agy-acp-map` + Windows + Zed 自定义 ACP 服务器。
> 结论先行：agy 侧的闪已由垫片解决；**剩下的闪只来自桥入口**（`bun/node.exe`
> 本身是控制台程序），必须在 Zed 侧用对启动方式。

## 1. 原理（一句话）

| 路径 | 谁负责 | 状态 |
|---|---|---|
| Zed → 桥（`bun`/`node`） | Zed 启动配置 | naive 启动会闪 1 个，用下述配置消除 |
| 桥 → agy（含预热、discovery、`taskkill`） | `dist/agy-headless.exe` + `windowsHide` | 已解决，零可见窗口（隐藏宿主属正常） |
| agy → 工具子进程 | agy 自身 | 桥够不着，`--sandbox` 收敛（见 §5） |

验证数据见 `tests/flash-watchdog.test.ts`（winexe 观察器复刻 GUI 父进程，
父链归因排除环境噪音）：垫片后零可见窗口；规范父进程下桥全链零可见。

## 2. 推荐配置（按顺序选）

### 方案 A（最稳）：垫片当命令

```jsonc
// Zed settings.json（键名随 Zed 版本为准，此处为示例结构）
{
  "agent_servers": {
    "agy-acp": {
      "command": "D:\\path\\to\\agy-acp-map\\dist\\agy-headless.exe",
      "args": [
        "node",
        "D:\\path\\to\\agy-acp-map\\dist\\bin.js"
      ],
      "env": {
        "AGY_HEADLESS_LAUNCHER": "D:\\path\\to\\agy-acp-map\\dist\\agy-headless.exe"
      }
    }
  }
}
```

原理：GUI 子系统的垫片先拿住进程位，再以 `CREATE_NO_WINDOW` 起 `node`，
Windows 从头到尾不分配可见控制台。

### 方案 B：直调 `node dist/bin.js`

Zed 新版本若起子进程自带 `CREATE_NO_WINDOW`（well-behaved），直调即可，
实测全链零可见窗口。首次先用 A，稳定后再试 B。

### 禁止项

* 不要指 `.cmd`/`.bat`（`run-zed-acp.cmd` 仅开发调试用）：`cmd.exe`
  自己先闪一个再转交，神仙难救。
* 不要指 `bun src/sdk-server.ts` 源文件路径做生产配置：多一层解析，
  且 `hideConsoleWindow()` 只在 Bun 下事后隐藏（闪一帧），Node 下是空操作。

## 3. 构建垫片（一次即可）

```powershell
bun run build:headless
```

* 有 Go：走 Go 主构建（自包含、无引号坑）。
* 无 Go：自动回退本机 `csc.exe`（C# 源码在 `native/agy-headless/agy-headless.cs`），
  零依赖，输出同样校验为 GUI 子系统，否则构建直接报错。
* 产物：`dist/agy-headless.exe`（`dist/` 不进 git，发布包自带；源码用户自己跑一次）。

## 4. 相关环境变量

| 变量 | 作用 |
|---|---|
| `AGY_HEADLESS_LAUNCHER` | 垫片绝对路径（找不到时显式指定） |
| `AGY_DISABLE_HEADLESS_LAUNCHER=1` | 强制直调（仅排查用，正常不要开） |
| `AGY_ACP_WARMUP=0` | 关闭连接即预热（批量建会话想省进程时用） |
| `AGY_ACP_SAFETY` / `AGY_ACP_SKIP_PERMISSIONS` | 默认 `autonomous`（自动放行 + 沙箱），见 README 安全模式表 |
| `AGY_BIN` | agy 可执行文件路径（默认自动找 `~/.gemini/bin` / `agy`） |

## 5. 验证与排错

```powershell
# 定点验证（含真实 GUI 父进程观测，约 60 秒）
bun test tests/flash-watchdog.test.ts --timeout 60000
```

* 日志出现 `[native CREATE_NO_WINDOW]`：垫片生效。
* 日志出现 `spawning agy.exe directly` / `disabled by AGY_DISABLE_HEADLESS_LAUNCHER`：
  垫片没找到或被关掉——检查第 3 步是否构建、路径是否有空格未转义由垫片处理（已覆盖）。
* 仍闪且只有 1 个：99% 是桥入口（方案 A 没用上），与 agy 无关。
* 工具执行瞬间闪：agy 生出的孙子进程，桥侧不可控；先确认 `--sandbox`
  默认开着，必要时 `AGY_ACP_SAFETY=autonomous-unsandboxed` 对照排查。
