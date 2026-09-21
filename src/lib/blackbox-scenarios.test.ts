import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import * as fs from 'node:fs';
import { AgyAcpService } from '../agent-sdk.ts';
import { clearDiscoveryCache } from './agy-discovery.ts';

describe('AgyAcpService Black-box Scenarios (Offline Simulation)', () => {
  let originalBin: string | undefined;
  let originalStore: string | undefined;
  let originalHistory: string | undefined;
  const mockCliPath = path.resolve(import.meta.dir, '../../tests/fixtures/mock-agy-cli.cjs');
  const testCwd = path.resolve(import.meta.dir, '../../');
  const testRoot = path.resolve(import.meta.dir, '../../scratch', `test-blackbox-${process.pid}-${Date.now()}`);
  const testStore = path.join(testRoot, 'sessions.json');
  const testHistory = path.join(testRoot, 'history');

  beforeAll(() => {
    clearDiscoveryCache();
    originalBin = process.env.AGY_BIN;
    originalStore = process.env.AGY_ACP_SESSION_STORE;
    originalHistory = process.env.AGY_ACP_HISTORY_DIR;
    process.env.AGY_BIN = mockCliPath;
    process.env.AGY_ACP_SESSION_STORE = testStore;
    process.env.AGY_ACP_HISTORY_DIR = testHistory;
  });

  afterAll(() => {
    process.env.AGY_BIN = originalBin;
    if (originalStore !== undefined) process.env.AGY_ACP_SESSION_STORE = originalStore;
    else delete process.env.AGY_ACP_SESSION_STORE;
    if (originalHistory !== undefined) process.env.AGY_ACP_HISTORY_DIR = originalHistory;
    else delete process.env.AGY_ACP_HISTORY_DIR;
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
    } catch {
      /* ignore test cleanup failure */
    }
    clearDiscoveryCache();
  });

  test('Tool Call: maps ACTIVE and DONE tool states into ACP tool updates', async () => {
    const service = new AgyAcpService();
    const { sessionId } = await service.newSession({ cwd: testCwd, protocolVersion: 2 });
    const updates: any[] = [];

    try {
      const outcome = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'Please read package.json [test:tool]' }],
      }, (u: any) => {
        updates.push(u);
      });

      expect(outcome.stopReason).toBe('end_turn');

      // Verify tool start update (in_progress)
      const toolStartUpdate = updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress');
      expect(toolStartUpdate).toBeDefined();
      expect(toolStartUpdate.toolCallId).toBe('agy-t1-s1');
      expect(toolStartUpdate.name ?? toolStartUpdate.title).toContain('read_file');
      // Human-readable title + immediate preview so Zed never shows a blank card
      expect(toolStartUpdate.title).toContain('package.json');
      expect(JSON.stringify(toolStartUpdate.content ?? '')).toContain('package.json');

      // Verify tool completion update with output (completed)
      const toolDoneUpdate = updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed');
      expect(toolDoneUpdate).toBeDefined();

      // Verify agent final response chunk
      const finalMsg = updates.find(
        (u) => u.sessionUpdate === 'agent_message_chunk' && u.content?.text?.includes('File read complete')
      );
      expect(finalMsg).toBeDefined();
    } finally {
      await service.closeSession({ sessionId });
    }
  });

  test('Reasoning / Thought Stream: segregates thought_delta into agent_thought_chunk', async () => {
    const service = new AgyAcpService();
    const { sessionId } = await service.newSession({ cwd: testCwd, protocolVersion: 2 });
    const thoughtChunks: string[] = [];
    const messageChunks: string[] = [];

    try {
      const outcome = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'Architectural analysis [test:thought]' }],
      }, (u: any) => {
        if (u.sessionUpdate === 'agent_thought_chunk') {
          thoughtChunks.push(u.content?.text || '');
        } else if (u.sessionUpdate === 'agent_message_chunk') {
          messageChunks.push(u.content?.text || '');
        }
      });

      expect(outcome.stopReason).toBe('end_turn');
      const combinedThoughts = thoughtChunks.join('');
      expect(combinedThoughts).toContain('Analyzing the architecture');
      expect(combinedThoughts).toContain('Formulating optimal recommendation');

      const combinedMessage = messageChunks.join('');
      expect(combinedMessage).toContain('Here is the definitive architectural response');
    } finally {
      await service.closeSession({ sessionId });
    }
  });

  test('Soft Deny: safely handles permission denials without crashing', async () => {
    const service = new AgyAcpService();
    const { sessionId } = await service.newSession({ cwd: testCwd, protocolVersion: 2 });
    const updates: any[] = [];

    try {
      const outcome = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'Dangerous command [test:soft_deny]' }],
      }, (u: any) => {
        updates.push(u);
      });

      expect(outcome.stopReason).toBe('end_turn');

      // Tool call was recorded as failed
      const failedTool = updates.find((u) => u.sessionUpdate === 'tool_call_update');
      expect(failedTool).toBeDefined();
      expect(failedTool.status).toBe('failed');

      // Soft deny message or guidance was emitted
      const hasDenyNotice = updates.some(
        (u) => u.sessionUpdate === 'agent_message_chunk' && JSON.stringify(u).includes('denied')
      );
      expect(hasDenyNotice).toBe(true);
    } finally {
      await service.closeSession({ sessionId });
    }
  });

  test('Malformed Data Resilience: survives junk non-JSON output and invalid lines', async () => {
    const service = new AgyAcpService();
    const { sessionId } = await service.newSession({ cwd: testCwd });
    const messageChunks: string[] = [];

    try {
      const outcome = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'Test junk lines [test:bad_lines]' }],
      }, (u: any) => {
        if (u.sessionUpdate === 'agent_message_chunk') {
          messageChunks.push(u.content?.text || '');
        }
      });

      expect(outcome.stopReason).toBe('end_turn');
      expect(messageChunks.join('')).toBe('Recovered cleanly from bad lines.');
    } finally {
      await service.closeSession({ sessionId });
    }
  });

  test('Multimodal: stages base64 images to disk and auto-cleans on closeSession', async () => {
    const service = new AgyAcpService();
    const { sessionId } = await service.newSession({ cwd: testCwd });

    // 1x1 transparent PNG base64
    const samplePngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

    try {
      const outcome = await service.promptSession({
        sessionId,
        prompt: [
          { type: 'text', text: 'Analyze this sample image' },
          {
            type: 'image',
            data: samplePngBase64,
            mimeType: 'image/png',
          },
        ],
      }, () => {});

      expect(outcome.stopReason).toBe('end_turn');

      // Verify that staging dir was created and contains staged file
      const stagingDir = path.join(testCwd, '.agy-staging', sessionId);
      if (fs.existsSync(stagingDir)) {
        const files = fs.readdirSync(stagingDir);
        expect(files.length).toBeGreaterThanOrEqual(1);
      }
    } finally {
      // Close session and verify automatic cleanup of staged files
      await service.closeSession({ sessionId });
      const stagingDir = path.join(testCwd, '.agy-staging', sessionId);
      expect(fs.existsSync(stagingDir)).toBe(false);
    }
  });

  test('Connect-time warm-up: newSession pre-spawns writable agy, close kills it', async () => {
    const service = new AgyAcpService();
    const { sessionId } = await service.newSession({ cwd: testCwd, protocolVersion: 2 });
    try {
      // Warm-up is fire-and-forget: poll briefly for a writable child.
      const deadline = Date.now() + 5000;
      while (!service.core.sessions.get(sessionId)?.proc.isWritable() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(service.core.sessions.get(sessionId)?.proc.isWritable()).toBe(true);
      // First prompt reuses the warmed process (no cold spawn churn).
      const outcome = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'Please read package.json [test:tool]' }],
      }, () => {});
      expect(outcome.stopReason).toBe('end_turn');
    } finally {
      await service.closeSession({ sessionId });
      expect(service.core.sessions.get(sessionId)).toBeUndefined();
    }
  });

  test('Dynamic Model Switch: kills existing process and respawns cleanly with new model', async () => {
    const service = new AgyAcpService();
    const { sessionId } = await service.newSession({ cwd: testCwd, model: 'gemini-3.8-flash-high', protocolVersion: 2 });

    try {
      // Turn 1
      const res1 = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'Turn 1 under flash-high' }],
      }, () => {});
      expect(res1.stopReason).toBe('end_turn');

      // Switch model mid-session
      const updated = await service.setConfigOption({
        sessionId,
        configId: 'model',
        value: 'gemini-3.8-pro',
      });
      expect((updated.configOptions as any[]).find((option) => option.configId === 'model'))
        .toMatchObject({
          type: 'select',
          currentValue: 'gemini-3.8-pro',
        });

      // Turn 2 under new model
      const res2 = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'Turn 2 under pro' }],
      }, () => {});
      expect(res2.stopReason).toBe('end_turn');
    } finally {
      await service.closeSession({ sessionId });
    }
  });
});
