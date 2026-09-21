import { AGENT_INFO, BRIDGE_CAPABILITIES } from '../core/types.ts';
import { AgySessionCore } from '../core/session-core.ts';
import { formatUpdateForProtocol } from '../lib/map-agy-to-acp.ts';
import { V1_AGENT_CAPABILITIES } from './types.ts';
import { buildV1ConfigOptions } from './config.ts';

export class AgyAcpV1Service {
  constructor(readonly core: AgySessionCore = new AgySessionCore()) {}

  async initialize(): Promise<any> {
    const discovery = await this.core.getDiscovery();
    const configOptions = buildV1ConfigOptions(discovery);

    // Strictly conforms to ACP v1 InitializeResponse schema:
    // Only protocolVersion, agentInfo, agentCapabilities, authMethods, _meta
    return {
      protocolVersion: 1,
      agentInfo: AGENT_INFO,
      agentCapabilities: V1_AGENT_CAPABILITIES,
      _meta: {
        bridgeCapabilities: {
          ...BRIDGE_CAPABILITIES,
          availableModels: discovery.availableModels,
          availableAgents: discovery.availableAgents,
          configOptions,
        },
        availableModels: discovery.availableModels,
        availableAgents: discovery.availableAgents,
      },
    };
  }

  async newSession(params: any): Promise<any> {
    const { session, discovery, meta } = await this.core.createSession(params, 1);
    return {
      sessionId: session.sessionId,
      configOptions: buildV1ConfigOptions(discovery, session),
      ...(meta ? { _meta: meta } : {}),
    };
  }

  async resumeSession(params: any): Promise<any> {
    const { session, discovery, meta } = await this.core.resumeSession(params, 1);
    return {
      configOptions: buildV1ConfigOptions(discovery, session),
      ...(meta ? { _meta: meta } : {}),
    };
  }

  async setConfigOption(params: any): Promise<any> {
    const { configOptions, meta } = await this.core.updateConfigOption(params, 1, buildV1ConfigOptions);
    return {
      configOptions,
      ...(meta ? { _meta: meta } : {}),
    };
  }

  async listSessions(params?: any): Promise<any> {
    return this.core.listSessions(params);
  }

  async closeSession(params: any): Promise<any> {
    return this.core.closeSession(params);
  }

  async deleteSession(params: any): Promise<any> {
    return this.core.deleteSession(params);
  }

  cancelSession(params: any): void {
    this.core.cancelSession(params);
  }

  promptSession(
    params: any,
    notifyClient: (update: any) => Promise<void> | void,
  ): Promise<{ stopReason: string }> {
    return this.core.promptTurn(params, 1, async (update) => {
      const formatted = formatUpdateForProtocol(update, 1);
      if (formatted) {
        await notifyClient(formatted);
      }
    });
  }
}
