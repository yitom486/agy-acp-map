import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgyAcpV1Service } from '../src/v1/adapter.ts';
import { AgySessionCore } from '../src/core/session-core.ts';
import { setCachedDiscoveryForTest, clearDiscoveryCache } from '../src/lib/agy-discovery.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Interrupted-turn history persistence (display/persist parity).
 *
 * The bug: cancelled/failed turns streamed partial text to the client but
 * persisted nothing, so a later session/load (Studio history switch, Zed
 * reopen) showed the user prompt with the answer missing.
 *
 * These tests drive full turns through the mock CLI: success, mid-stream
 * cancel, and mid-stream hard error — then assert the journal holds the
 * partial text (marked) and session/load replays it back.
 *
 * Isolation: dedicated AGY_BIN/store/history under a unique tmp root;
 * env is restored and the root removed in afterAll (nothing touches the
 * real ~/.agy-acp-map).
 */
describe('Interrupted-turn history persistence (mock streaming)', () => {
  const mockCliPath = path.resolve(__dirname, 'fixtures/mock-agy-cli.cjs');
  const testCwd = path.resolve(__dirname, '..');
  const testRoot = path.join(
    __dirname,
    '..',
    'scratch',
    `test-history-partial-${process.pid}-${Date.now()}`,
  );
  const tmpStore = path.join(testRoot, 'sessions.json');
  const tmpHistory = path.join(testRoot, 'history');

  let originalBin: string | undefined;
  let originalStore: string | undefined;
  let originalHistory: string | undefined;

  beforeAll(() => {
    originalBin = process.env.AGY_BIN;
    originalStore = process.env.AGY_ACP_SESSION_STORE;
    originalHistory = process.env.AGY_ACP_HISTORY_DIR;
    process.env.AGY_BIN = mockCliPath;
    process.env.AGY_ACP_SESSION_STORE = tmpStore;
    process.env.AGY_ACP_HISTORY_DIR = tmpHistory;
    setCachedDiscoveryForTest({
      availableModels: ['gemini-3.8-flash-high', 'gemini-3.8-pro'],
      availableAgents: ['coder', 'architect'],
    });
  });

  afterAll(() => {
    process.env.AGY_BIN = originalBin;
    if (originalStore !== undefined) {
      process.env.AGY_ACP_SESSION_STORE = originalStore;
    } else {
      delete process.env.AGY_ACP_SESSION_STORE;
    }
    if (originalHistory !== undefined) {
      process.env.AGY_ACP_HISTORY_DIR = originalHistory;
    } else {
      delete process.env.AGY_ACP_HISTORY_DIR;
    }
    clearDiscoveryCache();
    try {
      if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore test cleanup failures */
    }
  });

  async function waitFor(fn: () => boolean, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for stream condition');
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  function journalLines(sessionId: string): string[] {
    const file = path.join(tmpHistory, `${encodeURIComponent(sessionId)}.jsonl`);
    expect(fs.existsSync(file)).toBe(true);
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  }

  test('success turn persists Q&A without a partial marker, reload replays both', async () => {
    const core = new AgySessionCore();
    const svc = new AgyAcpV1Service(core);
    const { sessionId } = await svc.newSession({ cwd: testCwd });

    const outcome = await svc.promptSession(
      { sessionId, prompt: [{ type: 'text', text: 'Hello partial test' }] },
      () => {},
    );
    expect(outcome.stopReason).toBe('end_turn');

    const stored = core.historyStore.read(sessionId);
    expect(stored.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(stored[1].text).toContain('Mock response for [Hello partial test]');
    expect(stored[1].partial).toBeUndefined();

    const replayed: any[] = [];
    await svc.loadSession({ sessionId, cwd: testCwd, mcpServers: [] }, (u) => {
      replayed.push(u);
    });
    expect(replayed.map((u) => u.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
    ]);
    expect(replayed[1].content.text).toContain('Mock response for [Hello partial test]');

    await svc.closeSession({ sessionId });
  });

  test('cancelled turn persists the streamed partial text (marked), reload replays it', async () => {
    const core = new AgySessionCore();
    const svc = new AgyAcpV1Service(core);
    const { sessionId } = await svc.newSession({ cwd: testCwd });

    const updates: any[] = [];
    const pending = svc.promptSession(
      { sessionId, prompt: [{ type: 'text', text: 'Long job [test:cancel_delay]' }] },
      (u) => {
        updates.push(u);
      },
    );
    // Let the first text chunk stream out, then stop mid-turn.
    await waitFor(() =>
      updates.some(
        (u) =>
          u.sessionUpdate === 'agent_message_chunk' &&
          u.content?.text?.includes('Starting long process'),
      ),
    );
    await svc.cancelSession({ sessionId });
    const outcome = await pending;
    expect(outcome.stopReason).toBe('cancelled');

    // The client saw partial text; the journal must hold it too (marked).
    const stored = core.historyStore.read(sessionId);
    expect(stored.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(stored[1].text).toContain('Starting long process');
    expect(stored[1].partial).toBe(true);

    // Journal file stays valid JSONL after a kill (no corrupt tail).
    for (const line of journalLines(sessionId)) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    // Reload pulls the partial answer back — the history switch works.
    const replayed: any[] = [];
    await svc.loadSession({ sessionId, cwd: testCwd, mcpServers: [] }, (u) => {
      replayed.push(u);
    });
    const agentChunks = replayed.filter((u) => u.sessionUpdate === 'agent_message_chunk');
    expect(agentChunks.length).toBeGreaterThanOrEqual(1);
    expect(agentChunks.map((u) => u.content.text).join('')).toContain('Starting long process');

    await svc.closeSession({ sessionId });
  });

  test('hard-error turn persists partial text (marked) instead of dropping the turn', async () => {
    const core = new AgySessionCore();
    const svc = new AgyAcpV1Service(core);
    const { sessionId } = await svc.newSession({ cwd: testCwd });

    const updates: any[] = [];
    const outcome = await svc.promptSession(
      { sessionId, prompt: [{ type: 'text', text: 'Boom [test:hard_error]' }] },
      (u) => {
        updates.push(u);
      },
    );
    // Unknown non-success maps to idle end_turn with the error surfaced as text.
    expect(outcome.stopReason).toBe('end_turn');

    const stored = core.historyStore.read(sessionId);
    expect(stored.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(stored[1].text).toContain('Partial output before failure');
    expect(stored[1].partial).toBe(true);

    const replayed: any[] = [];
    await svc.loadSession({ sessionId, cwd: testCwd, mcpServers: [] }, (u) => {
      replayed.push(u);
    });
    expect(replayed.map((u) => u.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
    ]);

    await svc.closeSession({ sessionId });
  });

  test('empty assistant answer is still omitted (no fake answers on reload)', async () => {
    // Store-level guard: a turn with no visible text records user only.
    const core = new AgySessionCore();
    core.historyStore.appendTurn('sess-empty-check', 'Silent prompt', '');
    const stored = core.historyStore.read('sess-empty-check');
    expect(stored.map((r) => r.role)).toEqual(['user']);
  });
});
