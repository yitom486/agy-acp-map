import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgyAcpService, DEFAULT_AVAILABLE_COMMANDS } from '../src/agent-sdk.ts';
import { AgyAcpV1Service } from '../src/v1/adapter.ts';
import { AgyAcpV2Service } from '../src/v2/adapter.ts';
import { setCachedDiscoveryForTest, clearDiscoveryCache } from '../src/lib/agy-discovery.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Available Commands and /status Integration Tests', () => {
  let originalBin: string | undefined;
  let originalStore: string | undefined;
  let originalHistory: string | undefined;
  const mockCliPath = path.resolve(__dirname, 'fixtures/mock-agy-cli.cjs');
  const testCwd = path.resolve(__dirname, '..');
  const testRoot = path.join(__dirname, '..', 'scratch', `test-cmds-${process.pid}-${Date.now()}`);
  const tmpStore = path.join(testRoot, 'sessions.json');
  const tmpHistory = path.join(testRoot, 'history');

  beforeAll(() => {
    originalBin = process.env.AGY_BIN;
    originalStore = process.env.AGY_ACP_SESSION_STORE;
    originalHistory = process.env.AGY_ACP_HISTORY_DIR;
    process.env.AGY_BIN = mockCliPath;
    process.env.AGY_ACP_SESSION_STORE = tmpStore;
    process.env.AGY_ACP_HISTORY_DIR = tmpHistory;
    setCachedDiscoveryForTest({
      availableModels: ['gemini-2.5-pro', 'gemini-2.5-flash'],
      availableAgents: ['coder'],
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
      /* ignore */
    }
  });

  test('V1 newSession and resumeSession expose availableCommands', async () => {
    const service = new AgyAcpV1Service();
    const newRes = await service.newSession({ cwd: testCwd });
    expect(newRes.sessionId).toBeString();
    expect(newRes.availableCommands).toEqual(DEFAULT_AVAILABLE_COMMANDS);
    expect(newRes._meta?.availableCommands).toEqual(DEFAULT_AVAILABLE_COMMANDS);

    const resumeRes = await service.resumeSession({ sessionId: newRes.sessionId, cwd: testCwd });
    expect(resumeRes.availableCommands).toEqual(DEFAULT_AVAILABLE_COMMANDS);
    expect(resumeRes._meta?.availableCommands).toEqual(DEFAULT_AVAILABLE_COMMANDS);
  });

  test('V1 promptSession with /status responds instantly with formatted quota and limits', async () => {
    const service = new AgyAcpV1Service();
    const sessionRes = await service.newSession({ cwd: testCwd });
    const notifications: any[] = [];

    const outcome = await service.promptSession(
      {
        sessionId: sessionRes.sessionId,
        prompt: [{ type: 'text', text: '/status' }],
      },
      (update) => {
        notifications.push(update);
      },
    );

    expect(outcome.stopReason).toBe('end_turn');
    expect(notifications.length).toBeGreaterThan(0);
    const chunk = notifications.find((n) => n.sessionUpdate === 'agent_message_chunk');
    expect(chunk).toBeDefined();
    expect(chunk.content.text).toContain('Antigravity (agy) Status & Quota');
    expect(chunk.content.text).toContain('**5-Hour Limit**: 100% left');
    expect(chunk.content.text).toContain('**Weekly Limit**: 100% left');
    expect(chunk.content.text).toContain('**Credits**: unlimited');
  });

  test('V1 promptSession with /clear resets conversation state', async () => {
    const service = new AgyAcpV1Service();
    const sessionRes = await service.newSession({ cwd: testCwd });
    const notifications: any[] = [];

    const outcome = await service.promptSession(
      {
        sessionId: sessionRes.sessionId,
        prompt: [{ type: 'text', text: '/clear' }],
      },
      (update) => {
        notifications.push(update);
      },
    );

    expect(outcome.stopReason).toBe('end_turn');
    const chunk = notifications.find((n) => n.sessionUpdate === 'agent_message_chunk');
    expect(chunk).toBeDefined();
    expect(chunk.content.text).toContain('Context cleared');
  });

  test('V2 newSession and resumeSession expose availableCommands', async () => {
    const service = new AgyAcpV2Service();
    const newRes = await service.newSession({ cwd: testCwd });
    expect(newRes.sessionId).toBeString();
    expect(newRes.availableCommands).toEqual(DEFAULT_AVAILABLE_COMMANDS);
    expect(newRes._meta?.availableCommands).toEqual(DEFAULT_AVAILABLE_COMMANDS);

    const resumeRes = await service.resumeSession({ sessionId: newRes.sessionId, cwd: testCwd });
    expect(resumeRes.availableCommands).toEqual(DEFAULT_AVAILABLE_COMMANDS);
  });

  test('V2 promptSession with /status handles quota command and returns end_turn', async () => {
    const service = new AgyAcpV2Service();
    const sessionRes = await service.newSession({ cwd: testCwd });
    const notifications: any[] = [];

    const outcome = await service.promptSession(
      {
        sessionId: sessionRes.sessionId,
        prompt: [{ type: 'text', text: '/status' }],
      },
      (update) => {
        notifications.push(update);
      },
    );

    expect(outcome.stopReason).toBe('end_turn');
    const chunk = notifications.find((n) => n.sessionUpdate === 'agent_message_chunk' || n.sessionUpdate === 'agent_message');
    expect(chunk).toBeDefined();
    const text = chunk.content?.text || (Array.isArray(chunk.content) ? chunk.content[0].text : '');
    expect(text).toContain('**5-Hour Limit**: 100% left');
    expect(text).toContain('**Weekly Limit**: 100% left');
  });

  test('AgyAcpService composite handles both v1 and v2 available commands and status', async () => {
    const service = new AgyAcpService();
    const v1Session = await service.newSession({ cwd: testCwd, protocolVersion: 1 });
    expect(v1Session.availableCommands).toBeDefined();

    const notifications: any[] = [];
    const outcome = await service.promptSession(
      {
        sessionId: v1Session.sessionId,
        protocolVersion: 1,
        prompt: [{ type: 'text', text: '/status' }],
      },
      (u) => notifications.push(u),
    );

    expect(outcome.stopReason).toBe('end_turn');
    expect(notifications.some((n) => n.content?.text?.includes('Antigravity (agy) Status'))).toBeTrue();
  });
});
