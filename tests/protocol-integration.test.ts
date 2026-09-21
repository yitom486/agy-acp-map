import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgyAcpService, AGENT_INFO } from '../src/agent-sdk.ts';
import { AgyAcpV1Service } from '../src/v1/adapter.ts';
import { AgyAcpV2Service } from '../src/v2/adapter.ts';
import { AgySessionCore } from '../src/core/session-core.ts';
import { setCachedDiscoveryForTest, clearDiscoveryCache } from '../src/lib/agy-discovery.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Simulated Integration Tests (Offline Mock CLI)', () => {
  let originalBin: string | undefined;
  const mockCliPath = path.resolve(__dirname, 'fixtures/mock-agy-cli.cjs');
  const testCwd = path.resolve(__dirname, '..');

  beforeAll(() => {
    originalBin = process.env.AGY_BIN;
    process.env.AGY_BIN = mockCliPath;
    setCachedDiscoveryForTest({
      availableModels: ['gemini-3.8-flash-high', 'gemini-3.8-pro'],
      availableAgents: ['coder', 'architect'],
    });
  });

  afterAll(() => {
    process.env.AGY_BIN = originalBin;
    clearDiscoveryCache();
  });

  describe('ACP V1 Wire-level Conformance', () => {
    test('V1 initialize strictly encapsulates extensions in _meta without top-level leakage', async () => {
      const core = new AgySessionCore();
      const v1Service = new AgyAcpV1Service(core);
      const res = await v1Service.initialize();

      // Official ACP V1 Schema compliance
      expect(res.protocolVersion).toBe(1);
      expect(res.agentInfo.name).toBe(AGENT_INFO.name);
      expect(res.agentCapabilities.loadSession).toBe(false);
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
      await expect(v2Service.resumeSession({ sessionId })).rejects.toThrow(/created with ACP v1/);

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
      await expect(v1Service.resumeSession({ sessionId })).rejects.toThrow(/created with ACP v2/);

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
      const v1Resumed = await v1Service.resumeSession({ sessionId: legacySessionId });
      expect(v1Resumed.configOptions).toBeDefined();
      expect(core.sessions.has(legacySessionId)).toBe(true);

      // Close session in memory
      await v1Service.closeSession({ sessionId: legacySessionId });

      // V2 resume MUST be rejected because legacy session defaulted to v1
      await expect(v2Service.resumeSession({ sessionId: legacySessionId })).rejects.toThrow(
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
        expect(listResult.nextCursor).toBeNull();
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
  });
});

