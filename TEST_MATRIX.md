# TEST_MATRIX — agy-acp-map v0.4.0 (Bun + TypeScript)

Honest pass/fail after migration. Live tests need logged-in `agy` on PATH.

## Unit (no live agy)

| ID | Coverage | How | Result |
|----|----------|-----|--------|
| U1 | `buildAgyArgs` / `extractLaunchConfig` / `applyConfigOption` | `bun test src/lib/agy-args.test.ts` | PASS |
| U2 | `mapAgyEvent` init/text_delta/tool/result + sample ndjson | `bun test src/lib/map-agy-to-acp.test.ts` | PASS |
| U3 | `parseSoftDeny` / FromEvent / merge / format | `bun test src/lib/soft-deny.test.ts` | PASS |
| U4 | `normalizePromptBlocksSync` text + image staging (tmpdir) | `bun test src/lib/prompt-normalize.test.ts` | PASS |
| U5 | `extractImagePaths` + `fileToAcpImageBlock` + rich tool content | `bun test src/lib/rich-content.test.ts` | PASS |
| U6 | Legacy script parity | `bun src/test-agy-args.ts` | PASS |

## Integration / smoke (live agy)

| ID | Coverage | How | Result |
|----|----------|-----|--------|
| S1 | pong end-to-end | `bun src/client-smoke.ts` | PASS |
| S2 | model / conversation respawn / sandbox / json-schema | `bun src/client-smoke-flags.ts` | PASS |
| S3 | soft-deny (skip permissions=0) | `bun src/client-smoke-permissions.ts` | PASS |
| S4 | image input degrade-to-files | `bun src/client-smoke-image-in.ts` | PASS |
| S5 | image output generate + ACP image | `bun src/client-smoke-image-out.ts` | PASS |
| S6a | empty prompt → `-32602` | robustness | PASS |
| S6b | cancel mid-turn → next prompt works | robustness | PASS |
| S6c | invalid model → loud agy failure (not silent) | robustness | PASS |
| S6d | set_config_option busy → `-32002`; idle → next spawn flag | robustness | PASS |
| S6e | session/list shows conversationId after turn | robustness | PASS |

## Package scripts

| Script | Purpose |
|--------|---------|
| `bun test` / `bun test src/lib` | Unit matrix |
| `bun run smoke:all` | Units + all live smokes including robustness |
| `bun run start` | `bun src/server.ts` stdio agent |

## Known / documented behaviors

- Invalid `model` is **not** validated at `session/new`; failure is **loud at spawn** (agy stderr + agent text / idle).
- Soft-deny is advisory agent_message (no ACP permission UI round-trip).
- Image input always stages files; depends on agy `view_file` / vision.
