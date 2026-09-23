import { execFile } from 'node:child_process';
import { RequestError } from '@agentclientprotocol/sdk';

/**
 * ACP `mcpServers` → `agy mcp add/remove` bridging.
 *
 * The bridge owns MCP registration end-to-end:
 * - `session/new|resume` accept the standard ACP `mcpServers` list and sync
 *   it into agy's MCP config (`~/.gemini/config/mcp_config.json`) via
 *   `agy mcp add` BEFORE the session process spawns, so tools are listed
 *   from the first turn.
 * - `session/delete` removes the servers this session registered (refcounted
 *   per bridge process; best-effort, never breaks close/delete).
 * - Permissions stay under the bridge safety policy: MCP tool calls run with
 *   the session's `--dangerously-skip-permissions`/`--sandbox` flags, and
 *   headless soft-denies still surface `permissions.allow` guidance.
 *
 * Supported ACP shapes: stdio `{name, command, args, env[]}` and http
 * `{name, url, headers[], type:"http"}`. `sse`/`acp` transports have no
 * `agy mcp add` equivalent and fail fast (no silent downgrade).
 */

export interface AcpMcpServerInput {
  name?: unknown;
  type?: unknown;
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  headers?: unknown;
  [k: string]: unknown;
}

export interface NormalizedMcpServer {
  name: string;
  kind: 'stdio' | 'http';
  command?: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
  url?: string;
  headers: Array<{ name: string; value: string }>;
}

function fail(msg: string): never {
  throw new RequestError(-32602, msg);
}

function nonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function strArray(v: unknown, what: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    fail(`mcpServers[].${what} must be an array of strings`);
  }
  return v as string[];
}

function nameValueList(v: unknown, what: string): Array<{ name: string; value: string }> {
  if (v === undefined) return [];
  if (!Array.isArray(v)) fail(`mcpServers[].${what} must be an array`);
  return (v as unknown[]).map((e, i) => {
    if (!e || typeof e !== 'object') fail(`mcpServers[].${what}[${i}] must be {name, value}`);
    const rec = e as Record<string, unknown>;
    if (!nonEmptyString(rec.name) || typeof rec.value !== 'string') {
      fail(`mcpServers[].${what}[${i}] must be {name: string, value: string}`);
    }
    return { name: rec.name as string, value: rec.value as string };
  });
}

/**
 * Validate one ACP McpServer entry. Throws RequestError(-32602) — loud,
 * so a client that sent an unusable server never gets a silent no-tools
 * session.
 */
export function normalizeMcpServer(input: unknown): NormalizedMcpServer {
  if (!input || typeof input !== 'object') fail('mcpServers[] must be an object');
  const s = input as AcpMcpServerInput;
  if (!nonEmptyString(s.name)) fail('mcpServers[].name must be a non-empty string');
  const name = (s.name as string).trim();
  if (name.length > 64 || /[\s\x00-\x1f]/.test(name)) {
    fail(`mcpServers[].name must be ≤64 chars with no whitespace: ${JSON.stringify(name)}`);
  }

  const t = typeof s.type === 'string' ? s.type.trim().toLowerCase() : '';
  if (t === 'sse' || t === 'acp') {
    fail(
      `mcpServers[] '${name}': type '${t}' has no 'agy mcp add' equivalent ` +
        `(agy supports stdio|http only). Resend as stdio or http.`,
    );
  }
  if (t !== '' && t !== 'stdio' && t !== 'http') {
    fail(`mcpServers[] '${name}': unknown type ${JSON.stringify(s.type)} (want stdio|http)`);
  }

  const hasCommand = nonEmptyString(s.command);
  const hasUrl = nonEmptyString(s.url);
  if (hasCommand && hasUrl) {
    fail(`mcpServers[] '${name}': ambiguous (both command and url set); send one`);
  }
  if (t === 'http' || (!hasCommand && hasUrl)) {
    if (!hasUrl) fail(`mcpServers[] '${name}': http server needs a url`);
    const url = s.url as string;
    if (!/^https?:\/\//i.test(url)) fail(`mcpServers[] '${name}': url must start with http(s)://`);
    return { name, kind: 'http', args: [], env: [], url, headers: nameValueList(s.headers, 'headers') };
  }
  if (!hasCommand) {
    fail(`mcpServers[] '${name}': stdio server needs a command (or send type:"http" with a url)`);
  }
  return {
    name,
    kind: 'stdio',
    command: s.command as string,
    args: strArray(s.args, 'args'),
    env: nameValueList(s.env, 'env'),
    headers: [],
  };
}

/** Validate a full session/new|resume mcpServers list (non-array → loud). */
export function validateMcpServers(input: unknown): NormalizedMcpServer[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) fail('mcpServers must be an array');
  const seen = new Set<string>();
  return (input as unknown[]).map((e) => {
    const n = normalizeMcpServer(e);
    if (seen.has(n.name)) fail(`mcpServers[] duplicate name: '${n.name}'`);
    seen.add(n.name);
    return n;
  });
}

/**
 * Build `agy mcp add` argv. agy rejects flags placed after <name>, so all
 * flags come first: mcp add [--env K=V] [--header K:V] [--type t] <name>
 * <commandOrUrl> [args...].
 * stdio ALWAYS inserts `--` after <name>: agy consumes a global `--version`
 * (and may misparse other dash-args) even in post-positional slots, which
 * exits 0 while registering nothing (verified against agy 1.2.8). `--` ends
 * flag parsing so command/args pass through verbatim.
 */
export function mcpServerToAgyAddArgs(s: NormalizedMcpServer): string[] {
  const argv = ['mcp', 'add'];
  if (s.kind === 'stdio') {
    for (const e of s.env) argv.push('--env', `${e.name}=${e.value}`);
    argv.push(s.name, '--', s.command as string, ...s.args);
    return argv;
  }
  for (const h of s.headers) argv.push('--header', `${h.name}: ${h.value}`);
  argv.push('--type', 'http', s.name, s.url as string);
  return argv;
}

export interface McpRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable `agy mcp ...` runner (tests stub it; prod spawns agy). */
export type McpRunFn = (
  bin: string,
  args: string[],
  opts: { timeoutMs: number },
) => Promise<McpRunResult>;

function execFileAsync(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<McpRunResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true },
      (err: unknown, stdout: unknown, stderr: unknown) => {
        const e = err as { code?: unknown; killed?: boolean; message?: string } | null;
        resolve({
          status: typeof e?.code === 'number' ? (e.code as number) : e ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: e?.message ? `${e.message}\n${String(stderr ?? '')}` : String(stderr ?? ''),
        });
      },
    );
  });
}

/** Production runner: real `agy mcp ...` subprocess. */
export const defaultMcpRunFn: McpRunFn = (bin, args, opts) =>
  execFileAsync(bin, args, opts.timeoutMs);

function tail(text: string, n = 600): string {
  const t = String(text || '').trim();
  return t.length > n ? '…' + t.slice(-n) : t;
}

/**
 * Register every server via `agy mcp add` (idempotent: add == upsert).
 * Any failure throws RequestError — a client that asked for MCP must never
 * get a silent tools-less session.
 * Verify-after-add: agy exits 0 while registering NOTHING when argv contains
 * its global flags (`--version`/`--help` are swallowed even after `--`),
 * so every add is confirmed via `mcp list`. Absent-after-add throws loud.
 */
export async function syncMcpServers(
  bin: string,
  servers: NormalizedMcpServer[],
  runFn: McpRunFn = defaultMcpRunFn,
  timeoutMs = 30000,
): Promise<{ added: string[] }> {
  const added: string[] = [];
  for (const s of servers) {
    let r: McpRunResult;
    try {
      r = await runFn(bin, mcpServerToAgyAddArgs(s), { timeoutMs });
    } catch (err) {
      throw new RequestError(
        -32603,
        `failed to register MCP server '${s.name}': ${(err as Error)?.message || err}`,
      );
    }
    if (r.status !== 0) {
      throw new RequestError(
        -32603,
        `failed to register MCP server '${s.name}' (exit ${r.status}): ${tail(`${r.stdout}\n${r.stderr}`)}`,
      );
    }
    added.push(s.name);
  }
  if (added.length) {
    let listed = '';
    try {
      const lr = await runFn(bin, ['mcp', 'list'], { timeoutMs });
      listed = String(lr.stdout ?? '');
    } catch (err) {
      throw new RequestError(
        -32603,
        `registered MCP server(s) [${added.join(', ')}] but 'mcp list' verification failed: ${(err as Error)?.message || err}`,
      );
    }
    const lines = listed.split('\n');
    const missing = added.filter((n) => !lines.some((ln) => ln.includes(n)));
    if (missing.length) {
      throw new RequestError(
        -32603,
        `MCP server(s) [${missing.join(', ')}] exited 0 on 'mcp add' but are absent from 'mcp list' ` +
          `(agy swallows its global --version/--help flags even after '--'; check server args). ` +
          `List tail: ${tail(listed, 300)}`,
      );
    }
  }
  return { added };
}

/**
 * Remove servers by name. Best-effort by design: returns per-name warnings
 * instead of throwing, so session close/delete can never break on cleanup.
 */
export async function removeMcpServers(
  bin: string,
  names: string[],
  runFn: McpRunFn = defaultMcpRunFn,
  timeoutMs = 30000,
): Promise<{ removed: string[]; warnings: string[] }> {
  const removed: string[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    try {
      const r = await runFn(bin, ['mcp', 'remove', name], { timeoutMs });
      if (r.status !== 0) {
        warnings.push(`mcp remove '${name}' exit ${r.status}: ${tail(`${r.stdout}\n${r.stderr}`, 200)}`);
      } else {
        removed.push(name);
      }
    } catch (err) {
      warnings.push(`mcp remove '${name}' threw: ${(err as Error)?.message || err}`);
    }
  }
  if (warnings.length) {
    console.warn(`[ACP-MCP] cleanup warnings: ${warnings.join(' | ')}`);
  }
  return { removed, warnings };
}
