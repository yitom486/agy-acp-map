import { describe, test, expect } from 'bun:test';
import path from 'node:path';
import { AgyAcpService, createAcpV1App, createAcpV2App, createDualAcpApp, AGENT_INFO } from '../agent-sdk.ts';

describe('AgyAcpService & SDK Agent', () => {
  test('initialize returns expected capabilities and agentInfo', async () => {
    const service = new AgyAcpService();
    const res = await service.initialize();
    expect(res.agentInfo.name).toBe(AGENT_INFO.name);
    expect(res.capabilities.session).toBeDefined();
    expect(res.bridgeCapabilities.streaming).toBe(true);
    expect(res.bridgeCapabilities.tools).toBe(true);
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

  test('createAcpV1App and createAcpV2App return valid AgentApps', () => {
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
