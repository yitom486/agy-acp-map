# TEST_MATRIX — agy-acp-map v0.1.0 (Bun + TypeScript)

Honest pass/fail. Live tests need logged-in `agy` on PATH.

## Unit (no live agy)

| ID | Coverage | How | Result |
|----|----------|-----|--------|
| U1 | `buildAgyArgs` / safety / slash / printTimeout / `extractLaunchConfig` / `applyConfigOption` | `bun test src/lib/agy-args.test.ts` | PASS |
| U2 | `mapAgyEvent` init/text_delta/tool/result + **structured_output** + **response fallback** + **CANCELLED** + sample ndjson | `bun test src/lib/map-agy-to-acp.test.ts` | PASS |
| U3 | `parseSoftDeny` / FromEvent (tightened) / merge / format | `bun test src/lib/soft-deny.test.ts` | PASS |
| U4 | `normalizePromptBlocksSync` text + image staging + **size reject** + **cleanup** | `bun test src/lib/prompt-normalize.test.ts` | PASS |
| U5 | `extractImagePaths` + `fileToAcpImageBlock` + **allowlist** + rich tool content | `bun test src/lib/rich-content.test.ts` | PASS |
| U6 | `parseAgyModelsStdout` / `parseAgyAgentsStdout` fixtures | `bun test src/lib/agy-discovery.test.ts` | PASS |
| U7 | Legacy script parity | `bun src/test-agy-args.ts` | PASS |
| U8 | **Process manager** generation / error / kill | `bun test src/lib/agy-process.test.ts` | PASS |
| U9 | **Path allowlist** allow/deny/relative/staging/add-dir | `bun test src/lib/path-allowlist.test.ts` | PASS |

## Integration / smoke (live agy)

| ID | Coverage | How | Notes / Result |
|----|----------|-----|----------------|
| S1 | pong end-to-end (**safe** default) | `bun src/client-smoke.ts` | no skip env |
| S1a | pong autonomous | `AGY_ACP_SAFETY=autonomous bun src/client-smoke.ts` | may 429 |
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

## v0.1.0 behavior notes

- Child process supervision via `AgyProcessManager` (generation tokens; ignore stale NDJSON).
- Image reads allowlisted to session `cwd` / `.agy-acp-staging` / `additionalDirectories`.
- Staging: 8MB/blob, 32MB/turn; cleaned after idle/close unless `AGY_ACP_KEEP_STAGING=1`.
- Soft-deny requires permission/denied wording (generic tool ERROR ignored).
- `session/new` errors if `cwd` missing or not a directory.

## Live quota note

If `agy` returns `RESOURCE_EXHAUSTED` / 429, treat spawn-flag verification + unit tests as the authority for launch-flag / structured_output / discovery / hardening changes; re-run live smokes after quota reset.
