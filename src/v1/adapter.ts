import { AGENT_INFO } from '../core/types.ts';
import { AgySessionCore } from '../core/session-core.ts';
import { formatUpdateForProtocol } from '../lib/map-agy-to-acp.ts';
import { buildV1ConfigOptions } from './config.ts';
import { debugLog } from '../lib/debug-log.ts';

export class AgyAcpV1Service {
  constructor(readonly core: AgySessionCore = new AgySessionCore()) {}

  async initialize(): Promise<any> {
    debugLog('V1 initialize called');
    // NOTE (2026-09-22): minimal opencode-shaped response. Zed 1.20.2 closes
    // the connection on the previous full shape for unknown reasons; this
    // minimal shape is verified working in Zed (initialize -> session/new ->
    // prompt with model picker). Re-expand only with Zed-verified fields.
    debugLog('V1 initialize called (minimal response)');
    return {
      protocolVersion: 1,
      agentInfo: { name: AGENT_INFO.name, version: AGENT_INFO.version },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { close: {}, list: {}, resume: {} },
      },
      authMethods: [],
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

  async loadSession(
    params: any,
    notifyClient: (update: any) => Promise<void> | void,
  ): Promise<any> {
    // Read-only history replay: do not pre-spawn agy for it.
    const { session, discovery, meta } = await this.core.resumeSession(params, 1, { warmup: false });
    await this.core.replayHistory(session.sessionId, 1, notifyClient);
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

  async listSessions(params?: any, opts?: { now?: number }): Promise<any> {
    return this.core.listSessions(params, opts);
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
