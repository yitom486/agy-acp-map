import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import path from 'node:path';
import { AgyAcpService, createAcpV1App, createAcpV2App, createDualAcpApp, AGENT_INFO } from '../agent-sdk.ts';
import { setCachedDiscoveryForTest, clearDiscoveryCache } from './agy-discovery.ts';

describe('AgyAcpService & SDK Agent', () => {
  beforeAll(() => {
    setCachedDiscoveryForTest({
      availableModels: ['gemini-3.8-flash-high', 'gemini-3.8-flash-low'],
      availableAgents: ['coder', 'architect'],
    });
  });

  afterAll(() => {
    clearDiscoveryCache();
  });

  test('initialize returns catalog metadata without leaking non-standard protocol fields', async () => {
    const service = new AgyAcpService();
    const res = await service.initialize();
    expect(res.agentInfo.name).toBe(AGENT_INFO.name);
    expect(res.bridgeCapabilities.streaming).toBe(true);
    expect(res.bridgeCapabilities.tools).toBe(true);
    expect(res.bridgeCapabilities.resume).toBe(true);
    expect(res.availableModels).toContain('gemini-3.8-flash-high');
    expect(res.availableAgents).toContain('coder');

    const v1 = await service.initializeV1();
    expect(v1.protocolVersion).toBe(1);
    expect(v1.agentCapabilities.loadSession).toBe(true);
    expect(v1.agentCapabilities.sessionCapabilities.resume).toEqual({});
    expect((v1 as any).capabilities).toBeUndefined();

    const v2 = await service.initializeV2();
    expect(v2.protocolVersion).toBe(2);
    expect(v2.info.name).toBe(AGENT_INFO.name);
    expect(v2.capabilities.session.additionalDirectories).toEqual({});
    expect((v2 as any).agentCapabilities).toBeUndefined();
  });

  test('newSession rejects relative or missing cwd', async () => {
    const service = new AgyAcpService();
    expect(service.newSession({ cwd: 'relative/path' })).rejects.toThrow();
    expect(service.newSession({})).rejects.toThrow();
  });

  test('newSession creates and persists valid session with v1 defaults', async () => {
    const service = new AgyAcpService();
    const cwd = path.resolve(import.meta.dir, '../../');
    const res = await service.newSession({ cwd, model: 'test-model' });
    expect(res.sessionId).toBeDefined();
    expect(typeof res.sessionId).toBe('string');
    expect(res._meta?.model).toBe('test-model');

    const model = (res.configOptions as any[]).find((option) => option.id === 'model');
    expect(model).toMatchObject({
      type: 'select',
      id: 'model',
      currentValue: 'test-model',
    });
    expect(model.configId).toBeUndefined();
    expect(model.options.some((option: any) => option.value === 'test-model')).toBe(true);

    const list = await service.listSessions({ cwd });
    expect(list.sessions.some((s: any) => s.sessionId === res.sessionId)).toBe(true);

    await service.closeSession({ sessionId: res.sessionId });
  });

  test('resumeSession restores existing or persisted session', async () => {
    const service = new AgyAcpService();
    const cwd = path.resolve(import.meta.dir, '../../');
    const created = await service.newSession({ cwd, model: 'gemini-3.8-flash-high' });

    const resumed = await service.resumeSession({ sessionId: created.sessionId });
    expect(resumed._meta?.model).toBe('gemini-3.8-flash-high');
    expect(resumed.sessionId).toBeUndefined();
    expect((resumed.configOptions as any[]).find((option) => option.id === 'model'))
      .toMatchObject({
        type: 'select',
        currentValue: 'gemini-3.8-flash-high',
      });

    await service.closeSession({ sessionId: created.sessionId });
  });

  test('v2 uses configId selector key', async () => {
    const service = new AgyAcpService();
    const cwd = path.resolve(import.meta.dir, '../../');
    const created = await service.newSession({
      cwd,
      protocolVersion: 2,
      model: 'gemini-3.8-flash-high',
    });

    const model = (created.configOptions as any[]).find((option) => option.configId === 'model');
    expect(model).toMatchObject({
      type: 'select',
      configId: 'model',
      currentValue: 'gemini-3.8-flash-high',
    });
    expect(model.id).toBeUndefined();

    const resumed = await service.resumeSession({
      sessionId: created.sessionId,
      protocolVersion: 2,
    });
    expect((resumed.configOptions as any[]).some((option) => option.configId === 'model')).toBe(true);
    expect((resumed.configOptions as any[]).some((option) => option.id === 'model')).toBe(false);

    await service.closeSession({ sessionId: created.sessionId });
  });

  test('setConfigOption dynamically updates session model and safety', async () => {
    const service = new AgyAcpService();
    const cwd = path.resolve(import.meta.dir, '../../');
    const session = await service.newSession({ cwd, model: 'initial-model' });

    const updated = await service.setConfigOption({
      sessionId: session.sessionId,
      id: 'model',
      value: 'gemini-3.8-flash-low',
    });
    expect(updated.sessionId).toBeUndefined();
    expect(updated.id).toBeUndefined();
    expect(updated.value).toBeUndefined();
    expect(updated._meta?.model).toBe('gemini-3.8-flash-low');
    expect((updated.configOptions as any[]).find((option) => option.id === 'model'))
      .toMatchObject({
        type: 'select',
        currentValue: 'gemini-3.8-flash-low',
      });

    await service.closeSession({ sessionId: session.sessionId });
  });

  test('createAcpV1App and createAcpV2App return valid AgentApps with resume & config handlers', () => {
    const v1App = createAcpV1App();
    expect(v1App).toBeDefined();
    expect(typeof (v1App as any).connect).toBe('function');

    const v2App = createAcpV2App();
    expect(v2App).toBeDefined();
    expect(typeof (v2App as any).connect).toBe('function');

    const dual = createDualAcpApp();
    expect(dual).toBeDefined();
    expect(typeof dual.connect).toBe('function');
  });

  test('promptSession executes multi-turn consecutive prompts on same session cleanly without hanging (offline simulation)', async () => {
    const originalBin = process.env.AGY_BIN;
    const mockCliPath = path.resolve(import.meta.dir, '../../tests/fixtures/mock-agy-cli.cjs');
    process.env.AGY_BIN = mockCliPath;

    const service = new AgyAcpService();
    const cwd = path.resolve(import.meta.dir, '../../');
    const { sessionId } = await service.newSession({ cwd });

    try {
      // Turn 1
      const turn1Chunks: string[] = [];
      const res1 = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'First user prompt' }],
      }, (update: any) => {
        if (update.sessionUpdate === 'agent_message_chunk') {
          turn1Chunks.push(update.content?.text || '');
        }
      });
      expect(res1.stopReason).toBe('end_turn');
      expect(turn1Chunks.join('')).toBe('Mock response for [First user prompt] (turn 1)');

      // Turn 2 on the SAME session (validates that setCallbacks reroutes to Turn 2 and does not hang!)
      const turn2Chunks: string[] = [];
      const res2 = await service.promptSession({
        sessionId,
        prompt: [{ type: 'text', text: 'Second user prompt' }],
      }, (update: any) => {
        if (update.sessionUpdate === 'agent_message_chunk') {
          turn2Chunks.push(update.content?.text || '');
        }
      });
      expect(res2.stopReason).toBe('end_turn');
      expect(turn2Chunks.join('')).toBe('Mock response for [Second user prompt] (turn 2)');
    } finally {
      await service.closeSession({ sessionId });
      process.env.AGY_BIN = originalBin;
    }
  });
});
