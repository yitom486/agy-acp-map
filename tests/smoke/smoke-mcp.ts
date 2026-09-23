#!/usr/bin/env bun
/**
 * Live MCP smoke (needs real `agy` on PATH, no login required):
 * exercises the bridge's own ACP-shape validation + argv mapping against the
 * REAL `agy mcp` CLI: add -> list (visible) -> remove -> list (gone).
 * Uses a unique server name and always cleans up (try/finally) so the user's
 * real MCP config is untouched.
 */
import {
  validateMcpServers,
  syncMcpServers,
  removeMcpServers,
  defaultMcpRunFn,
} from '../../src/lib/mcp-servers.ts';

const BIN = process.env.AGY_BIN || process.env.AGY_BIN_PATH || 'agy';
const NAME = `agy-acp-smoke-${process.pid}`;
const TIMEOUT_MS = 30000;

const fail = (msg: string): never => {
  // Throw (never process.exit): the try/finally below must always run so a
  // failed run never leaves a stray server in the user's real MCP config.
  throw new Error(msg);
};
const ok = (msg: string) => console.log(`[smoke-mcp] ok: ${msg}`);

async function mcpList(): Promise<string> {
  const r = await defaultMcpRunFn(BIN, ['mcp', 'list'], { timeoutMs: TIMEOUT_MS });
  if (r.status !== 0) fail(`mcp list exit ${r.status}: ${(r.stdout + r.stderr).slice(-400)}`);
  return r.stdout;
}

const list0 = await mcpList();
ok(`baseline list (${list0.trim().split('\n').length} line(s))`);
if (list0.includes(NAME)) fail('stale smoke server from a previous run — remove manually');

// ACP-spec untagged stdio shape (no `type` field), exactly what a client sends.
// Args deliberately dash-leading (`-y ...`, like real `npx -y` servers): the
// bridge must pass them through verbatim after `--`.
// NOTE: never use `--version`/`--help` as probe args — agy swallows its global
// flags even after `--`, exits 0 and registers nothing (verified on agy 1.2.8).
const servers = validateMcpServers([
  {
    name: NAME,
    command: process.execPath,
    args: ['-y', 'agy-acp-smoke-probe'],
    env: [{ name: 'AGY_ACP_SMOKE', value: '1' }],
  },
]);
if (servers.length !== 1 || servers[0].kind !== 'stdio') fail('untagged stdio not normalized');

try {
  const { added } = await syncMcpServers(BIN, servers, defaultMcpRunFn, TIMEOUT_MS);
  if (!added.includes(NAME)) fail('sync did not report added');
  ok(`registered '${NAME}' via real agy mcp add`);

  const list1 = await mcpList();
  if (!list1.includes(NAME)) fail(`server missing from mcp list after add:\n${list1.slice(-500)}`);
  ok('visible in mcp list');
} finally {
  const { removed, warnings } = await removeMcpServers(BIN, [NAME], defaultMcpRunFn, TIMEOUT_MS);
  if (warnings.length) console.warn(`[smoke-mcp] cleanup warnings: ${warnings.join(' | ')}`);
  if (!removed.includes(NAME)) fail('cleanup remove did not report removed');
  const list2 = await mcpList();
  if (list2.includes(NAME)) fail('server still listed after remove');
  ok('removed + gone from list (config clean)');
}

console.log('[smoke-mcp] PASS');
