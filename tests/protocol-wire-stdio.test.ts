import { describe, test, expect, afterEach, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSmokeHarness, type SmokeHarness } from './smoke/helpers.ts';

const mockCliPath = path.resolve(import.meta.dir, 'fixtures/mock-agy-cli.cjs');
const repoRoot = path.resolve(import.meta.dir, '..');

describe('Wire-level Stdio JSON-RPC Integration (Full sdk-server Process)', () => {
  let activeHarness: SmokeHarness | null = null;
  let originalStore: string | undefined;
  let originalHistory: string | undefined;
  const testRootWire = path.join(repoRoot, 'scratch', `test-wire-${process.pid}-${Date.now()}`);
  const testStoreWire = path.join(testRootWire, 'sessions.json');
  const testHistoryWire = path.join(testRootWire, 'history');

  beforeAll(() => {
    originalStore = process.env.AGY_ACP_SESSION_STORE;
    originalHistory = process.env.AGY_ACP_HISTORY_DIR;
    process.env.AGY_ACP_SESSION_STORE = testStoreWire;
    process.env.AGY_ACP_HISTORY_DIR = testHistoryWire;
  });

  afterAll(() => {
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
    try {
      if (fs.existsSync(testRootWire)) fs.rmSync(testRootWire, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  afterEach(() => {
    if (activeHarness) {
      try {
        activeHarness.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      activeHarness = null;
    }
  });

  test(
    'V1 Wire Conformance: initialize schema purity, no illegal notifications, and tool_call -> tool_call_update sequence',
    async () => {
      const harness = createSmokeHarness({
        tag: 'v1-wire',
        env: {
          AGY_BIN: mockCliPath,
          NODE_ENV: 'test',
        },
      });
      activeHarness = harness;

      // 1. Initialize V1 over stdio
      const initRes = await harness.send('initialize', {
        protocolVersion: 1,
        capabilities: {},
        info: { name: 'zed-v1-client', version: '0.1.0' },
      });

      // Strict V1 Schema verification on the wire (minimal Zed-verified shape)
      expect(initRes.protocolVersion).toBe(1);
      const topKeys = Object.keys(initRes);
      expect(topKeys).not.toContain('bridgeCapabilities');
      expect(topKeys).not.toContain('availableModels');
      expect(topKeys).not.toContain('availableAgents');
      expect(Array.isArray(initRes.authMethods)).toBe(true);
      expect(initRes._meta).toBeUndefined();

      // 2. New Session V1
      const sessionRes = await harness.send('session/new', {
        cwd: repoRoot,
        mcpServers: [],
      });
      const sessionId = sessionRes.sessionId;
      expect(sessionId).toBeDefined();

      // 3. Prompt with tool trigger
      const promptPromise = harness.send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Inspect files [test:tool]' }],
      });

      const idle = await harness.waitIdle(15000, sessionId);
      const promptRes = await promptPromise;

      // In V1, prompt response contains stopReason
      expect(promptRes.stopReason).toBe('end_turn');
      expect(idle.stopReason).toBe('end_turn');

      // 4. Check all wire notifications emitted over stdout
      const notifyEvents = harness.events.filter((e) => e.subTag === 'notify');
      const sessionUpdates = notifyEvents
        .map((e) => e.obj?.params?.update)
        .filter(Boolean);

      // Rule: V1 MUST NOT emit user_message or state_update
      expect(sessionUpdates.some((u) => u.sessionUpdate === 'user_message')).toBe(false);
      expect(sessionUpdates.some((u) => u.sessionUpdate === 'state_update')).toBe(false);

      // Rule: Tool calls MUST follow the ACP v1 lifecycle: tool_call -> tool_call_update
      const toolCallEvents = sessionUpdates.filter((u) => u.sessionUpdate === 'tool_call');
      expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);
      expect(toolCallEvents[0].toolCallId).toBe('agy-t1-s1');
      expect(toolCallEvents[0].status).toBe('in_progress');

      const toolUpdateEvents = sessionUpdates.filter((u) => u.sessionUpdate === 'tool_call_update');
      expect(toolUpdateEvents.length).toBeGreaterThanOrEqual(1);
      expect(toolUpdateEvents.some((u) => u.status === 'completed')).toBe(true);

      // Check tool_call appeared before tool_call_update
      const firstCallIdx = sessionUpdates.findIndex((u) => u.sessionUpdate === 'tool_call');
      const firstUpdateIdx = sessionUpdates.findIndex((u) => u.sessionUpdate === 'tool_call_update');
      expect(firstCallIdx).toBeLessThan(firstUpdateIdx);

      // V1 advertises standard session/load replay, plus session list/resume/close
      expect(initRes.agentCapabilities?.loadSession).toBe(true);
      expect(initRes.agentCapabilities?.sessionCapabilities?.list).toBeDefined();
      expect(initRes.agentCapabilities?.sessionCapabilities?.resume).toBeDefined();

      // 5. Delete session over stdio wire
      const deleteRes = await harness.send('session/delete', { sessionId });
      expect(deleteRes).toEqual({});
    },
    30000,
  );

  test(
    'V2 Wire Conformance: initialize purity, empty prompt response {}, and running -> chunks -> idle state lifecycle',
    async () => {
      const harness = createSmokeHarness({
        tag: 'v2-wire',
        env: {
          AGY_BIN: mockCliPath,
          NODE_ENV: 'test',
        },
        onServerLog: (line) => console.error('SERVER LOG:', line),
      });
      activeHarness = harness;

      // 1. Initialize V2 over stdio
      const initRes = await harness.send('initialize', {
        protocolVersion: 2,
        capabilities: {},
        info: { name: 'acp-v2-client', version: '0.2.0' },
      });

      expect(initRes.protocolVersion).toBe(2);
      const topKeys = Object.keys(initRes);
      expect(topKeys).not.toContain('bridgeCapabilities');
      expect(topKeys).not.toContain('availableModels');
      expect(topKeys).not.toContain('availableAgents');
      expect(initRes._meta).toBeDefined();
      expect(initRes.capabilities?.session?.delete).toBeDefined();

      // 2. New Session V2
      const sessionRes = await harness.send('session/new', {
        cwd: repoRoot,
        mcpServers: [],
      });
      const sessionId = sessionRes.sessionId;
      expect(sessionId).toBeDefined();

      // 3. Prompt V2
      const promptPromise = harness.send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Execute step' }],
      });

      const idle = await harness.waitIdle(15000, sessionId);
      const promptRes = await promptPromise;

      // In ACP V2 draft, prompt response MUST be empty ({}) and not contain stopReason!
      expect(promptRes).toBeDefined();
      expect(promptRes.stopReason).toBeUndefined();

      // 4. Verify wire notification state flow: running -> ... -> idle
      const notifyEvents = harness.events.filter((e) => e.subTag === 'notify');
      const sessionUpdates = notifyEvents
        .map((e) => e.obj?.params?.update)
        .filter(Boolean);

      const stateUpdates = sessionUpdates.filter((u) => u.sessionUpdate === 'state_update');
      expect(stateUpdates.length).toBeGreaterThanOrEqual(2);
      expect(stateUpdates[0].state).toBe('running');
      expect(stateUpdates[stateUpdates.length - 1].state).toBe('idle');
      expect(stateUpdates[stateUpdates.length - 1].stopReason).toBe('end_turn');

      // 5. Delete session over stdio wire
      const deleteRes = await harness.send('session/delete', { sessionId });
      expect(deleteRes).toEqual({});
    },
    30000,
  );

  test(
    'V1 Wire History: persists agy NDJSON, reloads across ACP process restart, and continues with --conversation',
    async () => {
      const launchLog = path.join(testRootWire, 'mock-agy-launches.jsonl');
      const first = createSmokeHarness({
        tag: 'v1-history-create',
        env: {
          AGY_BIN: mockCliPath,
          NODE_ENV: 'test',
          MOCK_AGY_LAUNCH_LOG: launchLog,
        },
      });
      activeHarness = first;

      await first.send('initialize', {
        protocolVersion: 1,
        capabilities: {},
        info: { name: 'history-client', version: '0.1.0' },
      });
      const { sessionId } = await first.send('session/new', { cwd: repoRoot, mcpServers: [] });
      const promptPromise = first.send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Inspect files [test:tool]' }],
      });
      await first.waitIdle(15000, sessionId);
      await promptPromise;
      await first.send('session/close', { sessionId });

      // Inspect the actual durable artifacts before simulating a server restart.
      const storeFile = JSON.parse(fs.readFileSync(testStoreWire, 'utf8'));
      const storedSession = storeFile.sessions.find((item: any) => item.sessionId === sessionId);
      expect(storedSession).toBeDefined();
      expect(storedSession.conversationId).toBe('mock-conv-blackbox');
      expect(storedSession.protocolVersion).toBe(1);

      const resolvedHistoryFile = path.join(testHistoryWire, `${encodeURIComponent(sessionId)}.jsonl`);
      expect(fs.existsSync(resolvedHistoryFile)).toBe(true);
      const persistedHistory = fs
        .readFileSync(resolvedHistoryFile, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      expect(persistedHistory.map((record) => record.role)).toEqual(['user', 'assistant']);
      expect(persistedHistory[0].sessionId).toBe(sessionId);
      expect(persistedHistory[1].text).toContain('File read complete with success.');
      expect(fs.readFileSync(resolvedHistoryFile, 'utf8')).not.toContain('package.json');

      first.kill('SIGKILL');
      activeHarness = null;

      const second = createSmokeHarness({
        tag: 'v1-history-load',
        env: {
          AGY_BIN: mockCliPath,
          NODE_ENV: 'test',
          MOCK_AGY_LAUNCH_LOG: launchLog,
        },
      });
      activeHarness = second;
      await second.send('initialize', {
        protocolVersion: 1,
        capabilities: {},
        info: { name: 'history-client', version: '0.1.0' },
      });

      const listed = await second.send('session/list', { cwd: repoRoot });
      expect(listed.sessions.some((item: any) => item.sessionId === sessionId)).toBe(true);

      const loaded = await second.send('session/load', {
        sessionId,
        cwd: repoRoot,
        mcpServers: [],
      });
      expect(loaded.configOptions).toBeDefined();

      const replayed = second.events
        .filter((event) => event.subTag === 'notify')
        .map((event) => event.obj?.params?.update)
        .filter(Boolean);
      expect(replayed.map((update) => update.sessionUpdate)).toEqual([
        'user_message_chunk',
        'agent_message_chunk',
      ]);
      expect(replayed[1].content.text).toContain('File read complete with success.');
      expect(JSON.stringify(replayed)).not.toContain('package.json');

      // Loading history itself must not launch agy. The next prompt must,
      // however, launch a fresh mock process with the persisted conversation id.
      const continuation = second.send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Continue after reload' }],
      });
      await second.waitIdle(15000, sessionId);
      const continuationResult = await continuation;
      expect(continuationResult.stopReason).toBe('end_turn');

      const launches = fs
        .readFileSync(launchLog, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      // A script mock also services the optional catalog probes (`models` and
      // `agents`) during each server initialization. They are separate short-
      // lived processes, not conversation workers, so assert the resume handoff
      // against only the stream-json worker launches.
      const workerLaunches = launches.filter(
        (launch) => !launch.argv.includes('models') && !launch.argv.includes('agents'),
      );
      expect(workerLaunches).toHaveLength(2);
      expect(workerLaunches[0].argv).not.toContain('--conversation');
      const conversationIndex = workerLaunches[1].argv.indexOf('--conversation');
      expect(conversationIndex).toBeGreaterThanOrEqual(0);
      expect(workerLaunches[1].argv[conversationIndex + 1]).toBe('mock-conv-blackbox');

      const historyAfterContinuation = fs.readFileSync(resolvedHistoryFile, 'utf8');
      expect(historyAfterContinuation).not.toContain('package.json');
      expect(historyAfterContinuation).toContain('Continue after reload');

      await second.send('session/delete', { sessionId });
    },
    30000,
  );

  test(
    'V2 Wire History: session/resume replayFrom=start replays the JSONL display journal',
    async () => {
      const first = createSmokeHarness({
        tag: 'v2-history-create',
        env: { AGY_BIN: mockCliPath, NODE_ENV: 'test' },
      });
      activeHarness = first;

      await first.send('initialize', {
        protocolVersion: 2,
        capabilities: {},
        info: { name: 'history-client', version: '0.2.0' },
      });
      const { sessionId } = await first.send('session/new', { cwd: repoRoot, mcpServers: [] });
      const promptPromise = first.send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Inspect files [test:tool]' }],
      });
      await first.waitIdle(15000, sessionId);
      await promptPromise;
      await first.send('session/close', { sessionId });
      first.kill('SIGKILL');
      activeHarness = null;

      const second = createSmokeHarness({
        tag: 'v2-history-resume',
        env: { AGY_BIN: mockCliPath, NODE_ENV: 'test' },
      });
      activeHarness = second;
      await second.send('initialize', {
        protocolVersion: 2,
        capabilities: {},
        info: { name: 'history-client', version: '0.2.0' },
      });

      const resumed = await second.send('session/resume', {
        sessionId,
        cwd: repoRoot,
        mcpServers: [],
        replayFrom: { type: 'start' },
      });
      expect(resumed.configOptions).toBeDefined();

      const replayed = second.events
        .filter((event) => event.subTag === 'notify')
        .map((event) => event.obj?.params?.update)
        .filter(Boolean);
      expect(replayed.map((update) => update.sessionUpdate)).toEqual([
        'user_message',
        'agent_message',
      ]);
      expect(replayed[1].content[0].text).toContain('File read complete with success.');

      await second.send('session/delete', { sessionId });
    },
    30000,
  );

  test(
    'Wire-level Cross-Protocol Rejection: V2 cannot resume V1 session over JSON-RPC wire (-32602)',
    async () => {
      // Step A: Create session under V1 server
      const v1Harness = createSmokeHarness({
        tag: 'v1-prep',
        env: { AGY_BIN: mockCliPath, NODE_ENV: 'test' },
      });
      await v1Harness.send('initialize', {
        protocolVersion: 1,
        capabilities: {},
        info: { name: 'prep-client', version: '0.1.0' },
      });
      const { sessionId } = await v1Harness.send('session/new', {
        cwd: repoRoot,
        mcpServers: [],
      });
      v1Harness.kill('SIGKILL');

      // Step B: Connect V2 client over stdio and try to resume the V1 session
      const v2Harness = createSmokeHarness({
        tag: 'v2-cross-check',
        env: { AGY_BIN: mockCliPath, NODE_ENV: 'test' },
      });
      activeHarness = v2Harness;

      await v2Harness.send('initialize', {
        protocolVersion: 2,
        capabilities: {},
        info: { name: 'v2-client', version: '0.2.0' },
      });

      // Attempting to resume the V1 session must produce a JSON-RPC error with code -32602
      let caughtError: any = null;
      try {
        await v2Harness.send('session/resume', { sessionId, cwd: repoRoot });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeDefined();
      expect(caughtError.code).toBe(-32602);
      expect(caughtError.message).toMatch(/created with ACP v1 and cannot be resumed with v2/);
    },
    30000,
  );

  test(
    'Wire-level Session List: returns sessions array and pagination nextCursor over stdio wire',
    async () => {
      const harness = createSmokeHarness({
        tag: 'list-wire',
        env: { AGY_BIN: mockCliPath, NODE_ENV: 'test' },
      });
      activeHarness = harness;

      await harness.send('initialize', {
        protocolVersion: 1,
        capabilities: {},
        info: { name: 'list-client', version: '0.1.0' },
      });

      const listRes = await harness.send('session/list', { cwd: repoRoot });
      expect(Array.isArray(listRes.sessions)).toBe(true);
      if (listRes.nextCursor !== undefined) {
        expect(typeof listRes.nextCursor).toBe('string');
      }
    },
    30000,
  );

  test(
    'Wire-level V2 Invalid Prompt: empty prompt returns JSON-RPC error -32602 over stdio',
    async () => {
      const harness = createSmokeHarness({
        tag: 'v2-invalid-prompt',
        env: { AGY_BIN: mockCliPath, NODE_ENV: 'test', AGY_ACP_SESSION_STORE: testStoreWire },
      });
      activeHarness = harness;

      await harness.send('initialize', {
        protocolVersion: 2,
        capabilities: {},
        info: { name: 'v2-err-client', version: '0.2.0' },
      });

      const { sessionId } = await harness.send('session/new', { cwd: repoRoot });

      let caught: any = null;
      try {
        await harness.send('session/prompt', { sessionId, prompt: [] });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(caught.code).toBe(-32602);
      expect(caught.message).toMatch(/prompt must be a non-empty array/);

      await harness.send('session/delete', { sessionId });
    },
    30000,
  );
});
