import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgyAcpService, AGENT_INFO } from '../src/agent-sdk.ts';
import { AgyAcpV1Service } from '../src/v1/adapter.ts';
import { AgyAcpV2Service } from '../src/v2/adapter.ts';
import { createAcpV2App } from '../src/v2/app.ts';
import { AgySessionCore } from '../src/core/session-core.ts';
import { setCachedDiscoveryForTest, clearDiscoveryCache } from '../src/lib/agy-discovery.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Simulated Integration Tests (Offline Mock CLI)', () => {
  let originalBin: string | undefined;
  let originalStore: string | undefined;
  let originalHistory: string | undefined;
  const mockCliPath = path.resolve(__dirname, 'fixtures/mock-agy-cli.cjs');
  const testCwd = path.resolve(__dirname, '..');
  const testRoot = path.join(__dirname, '..', 'scratch', `test-integration-${process.pid}-${Date.now()}`);
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
      /* ignore */
    }
  });

  describe('ACP V1 Wire-level Conformance', () => {
    test('V1 initialize strictly encapsulates extensions in _meta without top-level leakage', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);
      const res = await v1Service.initialize();

      // Official ACP V1 Schema compliance
      expect(res.protocolVersion).toBe(1);
      expect(res.agentInfo.name).toBe(AGENT_INFO.name);
      expect(res.agentCapabilities.loadSession).toBe(true);
      expect(res.agentCapabilities.sessionCapabilities.delete).toBeDefined();
      expect(res.agentCapabilities.sessionCapabilities.resume).toBeDefined();

      // Verify non-standard extensions are strictly under _meta
      expect((res as any).availableModels).toBeUndefined();
      expect((res as any).availableAgents).toBeUndefined();
      expect((res as any).bridgeCapabilities).toBeUndefined();
      expect((res as any).capabilities).toBeUndefined();

      expect(res._meta.availableModels).toContain('gemini-3.8-flash-high');
      expect(res._meta.bridgeCapabilities.streaming).toBe(true);
      expect(res._meta.bridgeCapabilities.dynamicConfig).toBe('restart');
    });

    test('V1 promptSession emits NO user_message, NO state_update, and preserves native thought/tool updates', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);

      const { sessionId, configOptions } = await v1Service.newSession({ cwd: testCwd });
      expect(sessionId).toBeDefined();

      // V1 selector uses `id`
      const modelOpt = configOptions.find((o: any) => o.id === 'model');
      expect(modelOpt).toBeDefined();
      expect((modelOpt as any).configId).toBeUndefined();

      const receivedUpdates: any[] = [];
      const outcome = await v1Service.promptSession(
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Analyze this plan [test:thought]' }],
        },
        (update) => {
          receivedUpdates.push(update);
        },
      );

      // V1 prompt RPC outcome must resolve with stopReason
      expect(outcome.stopReason).toBe('end_turn');

      // 1. Assert NO user_message is sent in V1
      const userMsgUpdates = receivedUpdates.filter((u) => u.sessionUpdate === 'user_message');
      expect(userMsgUpdates.length).toBe(0);

      // 2. Assert NO state_update is sent in V1
      const stateUpdates = receivedUpdates.filter((u) => u.sessionUpdate === 'state_update');
      expect(stateUpdates.length).toBe(0);

      // 3. Assert agent_thought_chunk is preserved natively (NOT degraded to agent_message_chunk)
      const thoughtChunks = receivedUpdates.filter(
        (u) => u.sessionUpdate === 'agent_thought_chunk',
      );
      expect(thoughtChunks.length).toBeGreaterThanOrEqual(1);
      expect(thoughtChunks[0].content?.text).toContain('Analyzing the architecture');

      // 4. Assert normal agent_message_chunk is also emitted
      const messageChunks = receivedUpdates.filter(
        (u) => u.sessionUpdate === 'agent_message_chunk',
      );
      expect(messageChunks.length).toBeGreaterThanOrEqual(1);
      expect(messageChunks[0].content?.text).toContain('definitive architectural response');

      await v1Service.closeSession({ sessionId });
    });

    test('V1 preserves native tool_call and tool_call_update progress states', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);

      const { sessionId } = await v1Service.newSession({ cwd: testCwd });
      const updates: any[] = [];

      await v1Service.promptSession(
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Read test file [test:tool]' }],
        },
        (u) => {
          updates.push(u);
        },
      );

      // Assert initial tool_call with status in_progress is emitted
      const initialToolCall = updates.find(
        (u) => u.sessionUpdate === 'tool_call' && u.status === 'in_progress',
      );
      expect(initialToolCall).toBeDefined();
      expect(initialToolCall.toolCallId).toBe('agy-tool-1');
      expect(initialToolCall.title).toBe('read_file');

      // Assert subsequent tool_call_update with status completed is emitted
      const completedUpdate = updates.find(
        (u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed',
      );
      expect(completedUpdate).toBeDefined();

      await v1Service.closeSession({ sessionId });
    });

    test('V1 session/load replays only user and final assistant text from JSONL history', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);
      const { sessionId } = await v1Service.newSession({ cwd: testCwd });

      await v1Service.promptSession(
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Read test file [test:tool]' }],
        },
        () => {},
      );

      const stored = core.historyStore.read(sessionId);
      expect(stored.map((record) => record.role)).toEqual(['user', 'assistant']);
      expect(stored[1].text).toContain('File read complete with success.');
      expect(JSON.stringify(stored)).not.toContain('package.json');

      await v1Service.closeSession({ sessionId });

      const replayed: any[] = [];
      await v1Service.loadSession(
        { sessionId, cwd: testCwd, mcpServers: [] },
        (update) => {
          replayed.push(update);
        },
      );

      expect(replayed.map((update) => update.sessionUpdate)).toEqual([
        'user_message_chunk',
        'agent_message_chunk',
      ]);
      expect(replayed[0].content.text).toContain('Read test file');
      expect(replayed[1].content.text).toContain('File read complete with success.');

      await v1Service.deleteSession({ sessionId });
    });
  });

  describe('ACP V2 Wire-level Conformance', () => {
    test('V2 initialize strictly encapsulates extensions in _meta', async () => {
      const core = new AgySessionCore();
      const v2Service = new AgyAcpV2Service(core);
      const res = await v2Service.initialize();

      // Official ACP V2 Schema compliance
      expect(res.protocolVersion).toBe(2);
      expect(res.info.name).toBe(AGENT_INFO.name);
      expect(res.capabilities.session.additionalDirectories).toBeDefined();
      expect(res.capabilities.session.delete).toBeDefined();

      // Verify non-standard extensions are strictly under _meta
      expect((res as any).availableModels).toBeUndefined();
      expect((res as any).availableAgents).toBeUndefined();
      expect((res as any).bridgeCapabilities).toBeUndefined();
      expect((res as any).agentCapabilities).toBeUndefined();

      expect(res._meta.availableModels).toContain('gemini-3.8-flash-high');
      expect(res._meta.bridgeCapabilities.streaming).toBe(true);
    });

    test('V2 promptSession drives full state_update lifecycle: running -> chunks -> idle', async () => {
      const core = new AgySessionCore();
      const v2Service = new AgyAcpV2Service(core);

      const { sessionId, configOptions } = await v2Service.newSession({ cwd: testCwd });
      expect(sessionId).toBeDefined();

      // V2 selector uses `configId`
      const modelOpt = configOptions.find((o: any) => o.configId === 'model');
      expect(modelOpt).toBeDefined();
      expect((modelOpt as any).id).toBeUndefined();

      const updates: any[] = [];
      const outcome = await v2Service.promptSession(
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Testing v2 lifecycle' }],
        },
        (u) => {
          updates.push(u);
        },
      );

      // In ACP v2, promptSession returns stopReason to internal caller, but app returns {} on wire
      expect(outcome.stopReason).toBe('end_turn');

      // Verify state sequence: running -> chunks -> idle
      expect(updates[0].sessionUpdate).toBe('state_update');
      expect(updates[0].state).toBe('running');

      const lastUpdate = updates[updates.length - 1];
      expect(lastUpdate.sessionUpdate).toBe('state_update');
      expect(lastUpdate.state).toBe('idle');
      expect(lastUpdate.stopReason).toBe('end_turn');

      // In ACP v2, user_message notification IS emitted in state sequence
      expect(updates.some((u) => u.sessionUpdate === 'user_message')).toBe(true);

      await v2Service.closeSession({ sessionId });
    });

    test('V2 session/resume replayFrom=start replays JSONL display history without tools', async () => {
      const core = new AgySessionCore();
      const v2Service = new AgyAcpV2Service(core);
      const { sessionId } = await v2Service.newSession({ cwd: testCwd });

      await v2Service.promptSession(
        {
          sessionId,
          prompt: [{ type: 'text', text: 'Read test file [test:tool]' }],
        },
        () => {},
      );
      await v2Service.closeSession({ sessionId });

      const replayed: any[] = [];
      await v2Service.resumeSession(
        { sessionId, cwd: testCwd, mcpServers: [], replayFrom: { type: 'start' } },
        (update) => {
          replayed.push(update);
        },
      );

      expect(replayed.map((update) => update.sessionUpdate)).toEqual([
        'user_message',
        'agent_message',
      ]);
      expect(replayed[0].content[0].text).toContain('Read test file');
      expect(replayed[1].content[0].text).toContain('File read complete with success.');

      await v2Service.deleteSession({ sessionId });
    });

    test('V2 promptSession error path guarantees state_update: idle notification', async () => {
      const core = new AgySessionCore();
      const v2Service = new AgyAcpV2Service(core);

      const { sessionId } = await v2Service.newSession({ cwd: testCwd });
      const updates: any[] = [];

      // Pass invalid empty prompt to trigger promptTurn failure
      await expect(
        v2Service.promptSession(
          {
            sessionId,
            prompt: [], // empty prompt throws RequestError
          },
          (u) => {
            updates.push(u);
          },
        ),
      ).rejects.toThrow();

      // Verify state_update: running was emitted first
      expect(updates[0].sessionUpdate).toBe('state_update');
      expect(updates[0].state).toBe('running');

      // Verify state_update: idle was still emitted in finally block with stopReason error
      const lastUpdate = updates[updates.length - 1];
      expect(lastUpdate.sessionUpdate).toBe('state_update');
      expect(lastUpdate.state).toBe('idle');
      expect(lastUpdate.stopReason).toBe('error');

      await v2Service.closeSession({ sessionId });
    });
  });

  describe('Session Protocol Immutability & Isolation', () => {
    test('Session created under V1 cannot be resumed or modified by V2 adapter', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);
      const v2Service = new AgyAcpV2Service(core);

      const { sessionId } = await v1Service.newSession({ cwd: testCwd });

      // Attempt resume from V2 must be rejected
      await expect(v2Service.resumeSession({ sessionId, cwd: testCwd })).rejects.toThrow(/created with ACP v1/);

      // Attempt prompt from V2 must be rejected
      await expect(
        v2Service.promptSession({ sessionId, prompt: [{ type: 'text', text: 'fail' }] }, () => {}),
      ).rejects.toThrow(/protocol mismatch/);

      // Attempt setConfigOption from V2 must be rejected
      await expect(
        v2Service.setConfigOption({ sessionId, configId: 'model', value: 'gemini-3.8-pro' }),
      ).rejects.toThrow(/cannot be modified with v2/);

      await v1Service.closeSession({ sessionId });
    });

    test('Session created under V2 cannot be resumed or modified by V1 adapter', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);
      const v2Service = new AgyAcpV2Service(core);

      const { sessionId } = await v2Service.newSession({ cwd: testCwd });

      // Attempt resume from V1 must be rejected
      await expect(v1Service.resumeSession({ sessionId, cwd: testCwd })).rejects.toThrow(/created with ACP v2/);

      // Attempt prompt from V1 must be rejected
      await expect(
        v1Service.promptSession({ sessionId, prompt: [{ type: 'text', text: 'fail' }] }, () => {}),
      ).rejects.toThrow(/protocol mismatch/);

      // Attempt setConfigOption from V1 must be rejected
      await expect(
        v1Service.setConfigOption({ sessionId, id: 'model', value: 'gemini-3.8-pro' }),
      ).rejects.toThrow(/cannot be modified with v1/);

      await v2Service.closeSession({ sessionId });
    });

    test('Legacy session without protocolVersion in store defaults to v1 and rejects v2 resume', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);
      const v2Service = new AgyAcpV2Service(core);

      const legacySessionId = 'legacy-v1-session-001';
      // Simulate legacy store record written before v2 support was introduced
      core.sessionStore.upsert({
        sessionId: legacySessionId,
        cwd: testCwd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // protocolVersion is undefined (legacy record)
      });

      // V1 resume succeeds
      const v1Resumed = await v1Service.resumeSession({ sessionId: legacySessionId, cwd: testCwd });
      expect(v1Resumed.configOptions).toBeDefined();
      expect(core.sessions.has(legacySessionId)).toBe(true);

      // Close session in memory
      await v1Service.closeSession({ sessionId: legacySessionId });

      // V2 resume MUST be rejected because legacy session defaulted to v1
      await expect(v2Service.resumeSession({ sessionId: legacySessionId, cwd: testCwd })).rejects.toThrow(
        /created with ACP v1 and cannot be resumed with v2/,
      );

      // Clean up legacy session from store
      await v1Service.deleteSession({ sessionId: legacySessionId });
    });
  });

  describe('Standard ACP Session Lifecycle Enhancements', () => {
    test('session/delete terminates running process and purges memory and disk store', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);

      const { sessionId } = await v1Service.newSession({ cwd: testCwd });
      expect(core.sessions.has(sessionId)).toBe(true);
      expect(core.sessionStore.get(sessionId)).toBeDefined();

      // Invoke standard deleteSession
      const deleteResult = await v1Service.deleteSession({ sessionId });
      expect(deleteResult).toEqual({});

      // Memory and disk entries are completely purged
      expect(core.sessions.has(sessionId)).toBe(false);
      expect(core.sessionStore.get(sessionId)).toBeUndefined();
    });

    test('session/list returns deterministically sorted sessions with nextCursor pagination', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);

      // Create 3 sessions
      const s1 = await v1Service.newSession({ cwd: testCwd });
      const s2 = await v1Service.newSession({ cwd: testCwd });
      const s3 = await v1Service.newSession({ cwd: testCwd });

      const listResult = await v1Service.listSessions({ cwd: testCwd });
      expect(Array.isArray(listResult.sessions)).toBe(true);
      expect(listResult.sessions.length).toBeGreaterThanOrEqual(3);

      // Verify descending sort order by updatedAt
      for (let i = 0; i < listResult.sessions.length - 1; i++) {
        const timeCurr = new Date(listResult.sessions[i].updatedAt).getTime();
        const timeNext = new Date(listResult.sessions[i + 1].updatedAt).getTime();
        expect(timeCurr).toBeGreaterThanOrEqual(timeNext);
      }

      // Verify nextCursor behavior based on total session count
      if (listResult.sessions.length < 50) {
        expect(listResult.nextCursor).toBeFalsy();
      } else {
        expect(typeof listResult.nextCursor).toBe('string');
        const page2 = await v1Service.listSessions({ cwd: testCwd, cursor: listResult.nextCursor });
        expect(Array.isArray(page2.sessions)).toBe(true);
      }

      // Clean up created sessions
      await v1Service.deleteSession({ sessionId: s1.sessionId });
      await v1Service.deleteSession({ sessionId: s2.sessionId });
      await v1Service.deleteSession({ sessionId: s3.sessionId });
    });

    test('session/list deep pagination across multiple pages with >50 sessions and opaque cursor', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);

      const createdIds: string[] = [];
      try {
        for (let i = 0; i < 55; i++) {
          const s = await v1Service.newSession({ cwd: testCwd });
          createdIds.push(s.sessionId);
        }

        const page1 = await v1Service.listSessions({ cwd: testCwd });
        expect(page1.sessions.length).toBe(50);
        expect(typeof page1.nextCursor).toBe('string');

        const page2 = await v1Service.listSessions({ cwd: testCwd, cursor: page1.nextCursor });
        expect(page2.sessions.length).toBeGreaterThanOrEqual(5);

        // Invalid cursor token rejection
        await expect(v1Service.listSessions({ cwd: testCwd, cursor: 'invalid!cursor!token' })).rejects.toThrow(
          /Invalid cursor token/,
        );

        // Plain numeric cursor rejection (strictly opaque)
        await expect(v1Service.listSessions({ cwd: testCwd, cursor: '50' })).rejects.toThrow(
          /Invalid cursor token/,
        );

        // Relative cwd rejection
        await expect(v1Service.listSessions({ cwd: 'relative/dir' })).rejects.toThrow(
          /cwd must be an absolute path/,
        );
      } finally {
        for (const id of createdIds) {
          await v1Service.deleteSession({ sessionId: id });
        }
      }
    });

    test('staging directories are isolated per session and deleting session A preserves session B staging', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);

      const originalKeep = process.env.AGY_ACP_KEEP_STAGING;
      process.env.AGY_ACP_KEEP_STAGING = '1';
      try {
        const s1 = await v1Service.newSession({ cwd: testCwd });
        const s2 = await v1Service.newSession({ cwd: testCwd });

        const imgBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

        // Send prompt turn with image on s1 and s2
        await v1Service.promptSession({
          sessionId: s1.sessionId,
          prompt: [{ type: 'image', data: imgBase64, mimeType: 'image/png' }],
        }, () => {});

        await v1Service.promptSession({
          sessionId: s2.sessionId,
          prompt: [{ type: 'image', data: imgBase64, mimeType: 'image/png' }],
        }, () => {});

        const session1 = core.sessions.get(s1.sessionId)!;
        const session2 = core.sessions.get(s2.sessionId)!;

        expect(session1.stagedFiles.length).toBeGreaterThan(0);
        expect(session2.stagedFiles.length).toBeGreaterThan(0);
        const file1 = session1.stagedFiles[0];
        const file2 = session2.stagedFiles[0];

        expect(fs.existsSync(file1)).toBe(true);
        expect(fs.existsSync(file2)).toBe(true);
        expect(path.dirname(file1)).not.toBe(path.dirname(file2));

        // Delete session 1: its staged file should be removed, but session 2's staged file MUST remain!
        await v1Service.deleteSession({ sessionId: s1.sessionId });
        expect(fs.existsSync(file1)).toBe(false);
        expect(fs.existsSync(file2)).toBe(true);

        // Clean up session 2
        await v1Service.deleteSession({ sessionId: s2.sessionId });
        expect(fs.existsSync(file2)).toBe(false);
      } finally {
        if (originalKeep !== undefined) {
          process.env.AGY_ACP_KEEP_STAGING = originalKeep;
        } else {
          delete process.env.AGY_ACP_KEEP_STAGING;
        }
      }
    });

    test('V2 prompt rejects empty prompt blocks synchronously with -32602 before ACK', async () => {
      const core = new AgySessionCore();
      const v2Service = new AgyAcpV2Service(core);
      const v2App = createAcpV2App(v2Service);
      const v2Module = await import('@agentclientprotocol/sdk/experimental/v2');
      const client = v2Module.client();

      await client.connectWith(v2App, async (ctx) => {
        await ctx.request('initialize' as any, {
          protocolVersion: 2,
          capabilities: {},
          info: { name: 'v2-test-client', version: '0.1.0' },
        } as any);
        const { sessionId } = await ctx.request('session/new' as any, { cwd: testCwd } as any);

        // Prompt with empty array
        await expect(
          ctx.request('session/prompt' as any, { sessionId, prompt: [] } as any)
        ).rejects.toThrow(/prompt must be a non-empty array/);

        // Prompt with whitespace only
        await expect(
          ctx.request('session/prompt' as any, { sessionId, prompt: [{ type: 'text', text: '   ' }] } as any)
        ).rejects.toThrow(/prompt contains no valid/);

        await ctx.request('session/delete' as any, { sessionId } as any);
      });
    });

    test('session/resume validates cwd, replayFrom, mcpServers, and additionalDirectories strictly', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);

      const { sessionId } = await v1Service.newSession({
        cwd: testCwd,
        additionalDirectories: [path.resolve(testCwd, 'tests')],
      });

      // Missing cwd rejected
      await expect(v1Service.resumeSession({ sessionId })).rejects.toThrow(
        /cwd is required for session\/resume/,
      );

      // Relative cwd rejected
      await expect(v1Service.resumeSession({ sessionId, cwd: 'relative/path' })).rejects.toThrow(
        /cwd must be an absolute path/,
      );

      // Non-existent cwd rejected
      const nonExistentPath = path.join(testCwd, 'non-existent-folder-' + Date.now());
      await expect(v1Service.resumeSession({ sessionId, cwd: nonExistentPath })).rejects.toThrow(
        /cwd does not exist or is not a directory/,
      );

      // Mismatched cwd rejected
      const otherValidDir = path.resolve(testCwd, '..');
      await expect(v1Service.resumeSession({ sessionId, cwd: otherValidDir })).rejects.toThrow(
        /cwd does not match session cwd/,
      );

      // Unsupported replayFrom rejected
      await expect(
        v1Service.resumeSession({ sessionId, cwd: testCwd, replayFrom: { type: 'start' } }),
      ).rejects.toThrow(/replayFrom is only supported by ACP v2/);

      // Non-empty mcpServers rejected
      await expect(
        v1Service.resumeSession({ sessionId, cwd: testCwd, mcpServers: [{ name: 'dummy' }] }),
      ).rejects.toThrow(/mcpServers are not supported/);

      // Non-array additionalDirectories rejected
      await expect(v1Service.resumeSession({ sessionId, cwd: testCwd, additionalDirectories: 'not-an-array' })).rejects.toThrow(
        /additionalDirectories must be an array/,
      );

      // Omitted additionalDirectories resets active additional directories to []
      await v1Service.resumeSession({ sessionId, cwd: testCwd });
      const currentSession = core.sessions.get(sessionId);
      expect(currentSession?.additionalDirectories).toEqual([]);

      // Clean up
      await v1Service.deleteSession({ sessionId });
    });

    test('deleteSession prevents late finish or callback from resurrecting session in store', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);
      const { sessionId } = await v1Service.newSession({ cwd: testCwd });
      const session = core.sessions.get(sessionId)!;

      // Delete session immediately
      await v1Service.deleteSession({ sessionId });
      expect(core.sessions.has(sessionId)).toBe(false);
      expect(core.sessionStore.get(sessionId)).toBeUndefined();

      // Attempt to invoke persistSession on the deleted session object
      core.persistSession(session);
      // It MUST not resurrect the session in the store!
      expect(core.sessionStore.get(sessionId)).toBeUndefined();
    });

    test('validatePromptBlocks accepts resource_link and rejects empty media blocks', async () => {
      const { validatePromptBlocks } = await import('../src/lib/prompt-normalize.ts');

      // Valid text
      expect(validatePromptBlocks([{ type: 'text', text: 'hello' }]).ok).toBe(true);

      // Valid resource_link
      expect(validatePromptBlocks([{ type: 'resource_link', uri: 'file:///example.ts' }]).ok).toBe(true);
      expect(validatePromptBlocks([{ type: 'resource_link', name: 'my-link' }]).ok).toBe(true);

      // Valid embedded resource
      expect(validatePromptBlocks([{ type: 'resource', resource: { text: 'content' } }]).ok).toBe(true);

      // Valid image with data
      expect(validatePromptBlocks([{ type: 'image', data: 'aGVsbG8=' }]).ok).toBe(true);

      // Invalid: empty image block without data/uri
      expect(validatePromptBlocks([{ type: 'image' }]).ok).toBe(false);

      // Invalid: empty resource without text/blob
      expect(validatePromptBlocks([{ type: 'resource', resource: {} }]).ok).toBe(false);

      // Invalid: empty resource_link
      expect(validatePromptBlocks([{ type: 'resource_link' }]).ok).toBe(false);
    });
  });
});
