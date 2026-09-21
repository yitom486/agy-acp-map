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
      expect(res.agentCapabilities.loadSession).toBe(true);

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

      // Assert tool_call_update with status in_progress is preserved (not stripped)
      const inProgressUpdate = updates.find(
        (u) => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress',
      );
      expect(inProgressUpdate).toBeDefined();

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

      // Outcome stopReason
      expect(outcome.stopReason).toBe('end_turn');

      // First update must be state_update: running
      expect(updates[0]).toMatchObject({
        sessionUpdate: 'state_update',
        state: 'running',
      });

      // V2 supports user_message notification
      const userMsg = updates.find((u) => u.sessionUpdate === 'user_message');
      expect(userMsg).toBeDefined();

      // Last update must be state_update: idle with stopReason: 'end_turn'
      const lastUpdate = updates[updates.length - 1];
      expect(lastUpdate).toMatchObject({
        sessionUpdate: 'state_update',
        state: 'idle',
        stopReason: 'end_turn',
      });

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
      expect(v2Service.resumeSession({ sessionId })).rejects.toThrow(/created with ACP v1/);

      // Attempt prompt from V2 must be rejected
      expect(
        v2Service.promptSession({ sessionId, prompt: [{ type: 'text', text: 'fail' }] }, () => {}),
      ).rejects.toThrow(/protocol mismatch/);

      // Attempt setConfigOption from V2 must be rejected
      expect(
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
      expect(v1Service.resumeSession({ sessionId })).rejects.toThrow(/created with ACP v2/);

      // Attempt prompt from V1 must be rejected
      expect(
        v1Service.promptSession({ sessionId, prompt: [{ type: 'text', text: 'fail' }] }, () => {}),
      ).rejects.toThrow(/protocol mismatch/);

      // Attempt setConfigOption from V1 must be rejected
      expect(
        v1Service.setConfigOption({ sessionId, id: 'model', value: 'gemini-3.8-pro' }),
      ).rejects.toThrow(/cannot be modified with v1/);

      await v2Service.closeSession({ sessionId });
    });
  });
});
