import { AGENT_INFO, BRIDGE_CAPABILITIES } from '../core/types.ts';
import { AgySessionCore } from '../core/session-core.ts';
import { formatUpdateForProtocol } from '../lib/map-agy-to-acp.ts';
import { V2_AGENT_CAPABILITIES } from './types.ts';
import { buildV2ConfigOptions } from './config.ts';

export class AgyAcpV2Service {
  constructor(readonly core: AgySessionCore = new AgySessionCore()) {}

  async initialize(): Promise<any> {
    const discovery = await this.core.getDiscovery();
    const configOptions = buildV2ConfigOptions(discovery);

    // Strictly conforms to ACP v2 InitializeResponse schema:
    // Only protocolVersion, info, capabilities, authMethods, _meta
    return {
      protocolVersion: 2,
      info: AGENT_INFO,
      capabilities: V2_AGENT_CAPABILITIES,
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
    const { session, discovery, meta } = await this.core.createSession(params, 2);
    return {
      sessionId: session.sessionId,
      configOptions: buildV2ConfigOptions(discovery, session),
      ...(meta ? { _meta: meta } : {}),
    };
  }

  async resumeSession(params: any): Promise<any> {
    const { session, discovery, meta } = await this.core.resumeSession(params, 2);
    return {
      configOptions: buildV2ConfigOptions(discovery, session),
      ...(meta ? { _meta: meta } : {}),
    };
  }

  async setConfigOption(params: any): Promise<any> {
    const { configOptions, meta } = await this.core.updateConfigOption(params, 2, buildV2ConfigOptions);
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

  async promptSession(
    params: any,
    notifyClient: (update: any) => Promise<void> | void,
  ): Promise<{ stopReason: string }> {
    // Notify running state at the start of prompt processing
    await notifyClient({
      sessionUpdate: 'state_update',
      state: 'running',
    });

    let stopReason = 'end_turn';
    try {
      const outcome = await this.core.promptTurn(params, 2, async (update) => {
        const formatted = formatUpdateForProtocol(update, 2);
        if (formatted) {
          await notifyClient(formatted);
        }
      });
      stopReason = outcome?.stopReason || 'end_turn';
      return { stopReason };
    } catch (err) {
      stopReason = 'error';
      throw err;
    } finally {
      // Guarantee that state_update: idle is sent so client never hangs in 'running' state
      try {
        await notifyClient({
          sessionUpdate: 'state_update',
          state: 'idle',
          stopReason,
        });
      } catch {
        /* ignore notification errors during cleanup */
      }
    }
  }
}
