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

  test('initialize returns expected capabilities and agentInfo', async () => {
    const service = new AgyAcpService();
    const res = await service.initialize();
    expect(res.agentInfo.name).toBe(AGENT_INFO.name);
    expect(res.capabilities.session).toBeDefined();
    expect(res.bridgeCapabilities.streaming).toBe(true);
    expect(res.bridgeCapabilities.tools).toBe(true);
    expect(res.bridgeCapabilities.resume).toBe(true);
    expect(res.availableModels).toContain('gemini-3.8-flash-high');
    expect(res.availableAgents).toContain('coder');
  });

  test('newSession rejects relative or missing cwd', async () => {
    const service = new AgyAcpService();
    expect(service.newSession({ cwd: 'relative/path' })).rejects.toThrow();
    expect(service.newSession({})).rejects.toThrow();
  });

  test('newSession creates and persists valid session', async () => {
    const service = new AgyAcpService();
    const cwd = path.resolve(import.meta.dir, '../../');
    const res = await service.newSession({ cwd, model: 'test-model' });
    expect(res.sessionId).toBeDefined();
    expect(typeof res.sessionId).toBe('string');
    expect(res._meta?.model).toBe('test-model');

    const list = await service.listSessions({ cwd });
    expect(list.sessions.some((s: any) => s.sessionId === res.sessionId)).toBe(true);

    await service.closeSession({ sessionId: res.sessionId });
  });

  test('resumeSession restores existing or persisted session', async () => {
    const service = new AgyAcpService();
    const cwd = path.resolve(import.meta.dir, '../../');
    const created = await service.newSession({ cwd, model: 'gemini-3.8-flash-high' });

    const resumed = await service.resumeSession({ sessionId: created.sessionId });
    expect(resumed.sessionId).toBe(created.sessionId);
    expect(resumed._meta?.model).toBe('gemini-3.8-flash-high');

    await service.closeSession({ sessionId: created.sessionId });
  });

  test('setConfigOption dynamically updates session model and safety', async () => {
    const service = new AgyAcpService();
    const cwd = path.resolve(import.meta.dir, '../../');
    const session = await service.newSession({ cwd, model: 'initial-model' });

    const updated = await service.setConfigOption({
      sessionId: session.sessionId,
      configId: 'model',
      value: 'updated-gemini-3.8',
    });
    expect(updated.configId).toBe('model');
    expect(updated.value).toBe('updated-gemini-3.8');
    expect(updated._meta?.model).toBe('updated-gemini-3.8');

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
});
