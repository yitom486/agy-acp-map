# TEST_MATRIX — agy-acp-map v0.4.1 (Bun + TypeScript)

Honest pass/fail. Live tests need logged-in `agy` on PATH.

## Unit (no live agy)

| ID | Coverage | How | Result |
|----|----------|-----|--------|
| U1 | `buildAgyArgs` / safety / slash / printTimeout / `extractLaunchConfig` / `applyConfigOption` | `bun test src/lib/agy-args.test.ts` | PASS |
| U2 | `mapAgyEvent` init/text_delta/tool/result + **structured_output** + sample ndjson | `bun test src/lib/map-agy-to-acp.test.ts` | PASS |
| U3 | `parseSoftDeny` / FromEvent / merge / format | `bun test src/lib/soft-deny.test.ts` | PASS |
| U4 | `normalizePromptBlocksSync` text + image staging (tmpdir) | `bun test src/lib/prompt-normalize.test.ts` | PASS |
| U5 | `extractImagePaths` + `fileToAcpImageBlock` + rich tool content | `bun test src/lib/rich-content.test.ts` | PASS |
| U6 | `parseAgyModelsStdout` / `parseAgyAgentsStdout` fixtures | `bun test src/lib/agy-discovery.test.ts` | PASS |
| U7 | Legacy script parity | `bun src/test-agy-args.ts` | PASS |

## Integration / smoke (live agy)

| ID | Coverage | How | Notes / Result |
|----|----------|-----|----------------|
| S1 | pong end-to-end (**safe** default) | `bun src/client-smoke.ts` | no skip env |
| S2 | model / conversation / sandbox / json-schema | `bun src/client-smoke-flags.ts` | sets `AGY_ACP_SAFETY=autonomous` |
| S3 | soft-deny (skip=0 / safe) | `bun src/client-smoke-permissions.ts` | PASS path |
| S4 | image input degrade-to-files | `bun src/client-smoke-image-in.ts` | autonomous |
| S5 | image output generate + ACP image | `bun src/client-smoke-image-out.ts` | autonomous |
| S6 | cancel / empty / bad model / set_config / list | `bun src/client-smoke-robustness.ts` | autonomous |

## Package scripts

| Script | Purpose |
|--------|---------|
| `bun test` / `bun test src/lib` | Unit matrix |
| `bun run smoke:all` | Units + all live smokes including robustness |
| `bun run start` | `bun src/server.ts` stdio agent |

## v0.4.1 behavior notes

- Default **safe**: no `--dangerously-skip-permissions`; soft-deny scrape remains useful.
- Always passes `--disable-slash-commands` unless `AGY_ACP_DISABLE_SLASH_COMMANDS=0` / `disableSlashCommands: false`.
- `--print-timeout` configurable (default `0`).
- `initialize` discovers `availableModels` / `availableAgents` (best-effort).
- `result.structured_output` → fenced JSON `agent_message_chunk`.

## Live quota note

If `agy` returns `RESOURCE_EXHAUSTED` / 429, treat spawn-flag verification + unit tests as the authority for launch-flag / structured_output / discovery changes; re-run live smokes after quota reset.
