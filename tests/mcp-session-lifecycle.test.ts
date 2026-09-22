import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgyAcpV1Service } from '../src/v1/adapter.ts';
import { AgySessionCore } from '../src/core/session-core.ts';
import { setCachedDiscoveryForTest, clearDiscoveryCache } from '../src/lib/agy-discovery.ts';
import type { McpRunFn } from '../src/lib/mcp-servers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * MCP session lifecycle (fake `agy mcp` runner — never touches the real
 * global ~/.gemini/config/mcp_config.json).
 *
 * Covers the reported bug: session/resume with non-empty mcpServers used to
 * hard-fail (-32602), forcing clients to session/new every time. Now new
 * registers, resume reconciles, delete unregisters refcounted servers.
 *
 * Isolation: dedicated store/history under a unique tmp root; env restored
 * and the root removed in afterAll.
 */
describe('MCP session lifecycle (fake agy mcp runner)', () => {
  const mockCliPath = path.resolve(__dirname, 'fixtures/mock-agy-cli.cjs');
  const testCwd = path.resolve(__dirname, '..');
  const testRoot = path.join(
    __dirname,
    '..',
    'scratch',
    `test-mcp-lifecycle-${process.pid}-${Date.now()}`,
  );
  const tmpStore = path.join(testRoot, 'sessions.json');
  const tmpHistory = path.join(testRoot, 'history');

  let originalBin: string | undefined;
  let originalStore: string | undefined;
  let originalHistory: string | undefined;
  let originalWarmup: string | undefined;

  const calls: Array<{ bin: string; args: string[] }> = [];
  const fakeRunner: McpRunFn = async (bin, args) => {
    calls.push({ bin, args });
    return { status: 0, stdout: 'ok', stderr: '' };
  };

  const lumina = {
    name: 'lumina',
    command: 'node',
    args: ['mcp-server.js'],
    env: [{ name: 'LUMINA_PORT', value: '3801' }],
  };
  const web = {
    name: 'web',
    type: 'http',
    url: 'https://example.com/mcp',
    headers: [{ name: 'Authorization', value: 'Bearer T' }],
  };

  function makeCore() {
    return new AgySessionCore({
      sessionStore: tmpStore,
      historyStore: tmpHistory,
      mcpRunner: fakeRunner,
    });
  }

  beforeAll(() => {
    originalBin = process.env.AGY_BIN;
    originalStore = process.env.AGY_ACP_SESSION_STORE;
    originalHistory = process.env.AGY_ACP_HISTORY_DIR;
    originalWarmup = process.env.AGY_ACP_WARMUP;
    process.env.AGY_BIN = mockCliPath;
    process.env.AGY_ACP_SESSION_STORE = tmpStore;
    process.env.AGY_ACP_HISTORY_DIR = tmpHistory;
    process.env.AGY_ACP_WARMUP = '0';
    setCachedDiscoveryForTest({
      availableModels: ['gemini-3.8-flash-high'],
      availableAgents: ['coder'],
    });
  });

  afterAll(() => {
    process.env.AGY_BIN = originalBin;
    if (originalStore !== undefined) process.env.AGY_ACP_SESSION_STORE = originalStore;
    else delete process.env.AGY_ACP_SESSION_STORE;
    if (originalHistory !== undefined) process.env.AGY_ACP_HISTORY_DIR = originalHistory;
    else delete process.env.AGY_ACP_HISTORY_DIR;
    if (originalWarmup !== undefined) process.env.AGY_ACP_WARMUP = originalWarmup;
    else delete process.env.AGY_ACP_WARMUP;
    clearDiscoveryCache();
    try {
      if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore test cleanup failures */
    }
  });

  test('session/new registers MCP servers before spawn; resume reconciles instead of failing', async () => {
    calls.length = 0;
    const core = makeCore();
    const svc = new AgyAcpV1Service(core);

    const { sessionId } = await svc.newSession({
      cwd: testCwd,
      mcpServers: [lumina, web],
    });
    const adds = calls.filter((c) => c.args[1] === 'add');
    expect(adds).toHaveLength(2);
    expect(adds[0].args).toEqual([
      'mcp',
      'add',
      '--env',
      'LUMINA_PORT=3801',
      'lumina',
      'node',
      'mcp-server.js',
    ]);
    expect(adds[1].args).toEqual([
      'mcp',
      'add',
      '--header',
      'Authorization: Bearer T',
      '--type',
      'http',
      'web',
      'https://example.com/mcp',
    ]);
    // Flags precede <name> or agy rejects the invocation.
    for (const a of adds) {
      const nameIdx = a.args.indexOf('lumina') >= 0 ? a.args.indexOf('lumina') : a.args.indexOf('web');
      for (const [i, tok] of a.args.entries()) {
        if (tok.startsWith('--')) expect(i).toBeLessThan(nameIdx);
      }
    }
    expect(core.sessions.get(sessionId)?.mcpServers).toEqual([{ name: 'lumina' }, { name: 'web' }]);

    // resume with the same servers reconciles (idempotent) — no more -32602.
    calls.length = 0;
    await svc.resumeSession({ sessionId, cwd: testCwd, mcpServers: [lumina, web] });
    expect(calls.filter((c) => c.args[1] === 'add')).toHaveLength(2);

    // delete unregisters exactly this session's servers.
    calls.length = 0;
    await svc.deleteSession({ sessionId });
    expect(calls.map((c) => c.args)).toEqual([
      ['mcp', 'remove', 'lumina'],
      ['mcp', 'remove', 'web'],
    ]);
  });

  test('shared servers are removed only after the last session referencing them goes away', async () => {
    calls.length = 0;
    const core = makeCore();
    const svc = new AgyAcpV1Service(core);

    const a = await svc.newSession({ cwd: testCwd, mcpServers: [lumina] });
    const b = await svc.newSession({ cwd: testCwd, mcpServers: [lumina] });

    calls.length = 0;
    await svc.deleteSession({ sessionId: a.sessionId });
    expect(calls.map((c) => c.args)).toEqual([]);

    await svc.deleteSession({ sessionId: b.sessionId });
    expect(calls.map((c) => c.args)).toEqual([['mcp', 'remove', 'lumina']]);
  });

  test('unsupported transports and malformed entries fail fast and loud', async () => {
    const core = makeCore();
    const svc = new AgyAcpV1Service(core);

    await expect(
      svc.newSession({
        cwd: testCwd,
        mcpServers: [{ name: 's', type: 'sse', url: 'http://x/sse' }],
      }),
    ).rejects.toThrow(/no 'agy mcp add' equivalent/);

    const { sessionId } = await svc.newSession({ cwd: testCwd });
    await expect(
      svc.resumeSession({ sessionId, cwd: testCwd, mcpServers: [{ name: 'x' }] }),
    ).rejects.toThrow(/needs a command/);
    await svc.deleteSession({ sessionId });
  });

  test('registration failure fails session/new loudly (never a silent tools-less session)', async () => {
    const failing = new AgySessionCore({
      sessionStore: tmpStore,
      historyStore: tmpHistory,
      mcpRunner: async () => ({ status: 1, stdout: '', stderr: 'denied' }),
    });
    const svc = new AgyAcpV1Service(failing);
    await expect(
      svc.newSession({ cwd: testCwd, mcpServers: [lumina] }),
    ).rejects.toThrow(/failed to register MCP server 'lumina'.*denied/);
  });
});
