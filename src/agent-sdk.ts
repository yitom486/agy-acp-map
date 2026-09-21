/**
 * Official ACP v1/v2 Agent SDK Facade.
 *
 * All business and protocol logic has been modularized into:
 * - src/core/ (Session lifecycle, Process supervisor, FIFO queue, Shared types)
 * - src/v1/   (ACP v1 Production standard: Capabilities, Config, Adapter, App)
 * - src/v2/   (ACP v2 Experimental draft: Capabilities, Config, Adapter, App)
 * - src/router.ts (Dual v1/v2 Protocol Router)
 *
 * This facade maintains 100% backward compatibility with all existing imports.
 */

import { AgySessionCore } from './core/session-core.ts';
import { AgyAcpV1Service } from './v1/adapter.ts';
import { AgyAcpV2Service } from './v2/adapter.ts';
import type { ProtocolVersion, SdkSession } from './core/types.ts';

export { AGENT_INFO, BRIDGE_CAPABILITIES, type SdkSession } from './core/types.ts';
export { AgySessionCore } from './core/session-core.ts';
export { AgyAcpV1Service } from './v1/adapter.ts';
export { createAcpV1App } from './v1/app.ts';
export { AgyAcpV2Service } from './v2/adapter.ts';
export { createAcpV2App } from './v2/app.ts';
export { createDualAcpApp } from './router.ts';

/**
 * Composite service providing backward-compatible access to both ACP v1 and v2.
 * Delegates to AgyAcpV1Service and AgyAcpV2Service over a shared AgySessionCore.
 */
export class AgyAcpService {
  readonly core: AgySessionCore;
  readonly v1: AgyAcpV1Service;
  readonly v2: AgyAcpV2Service;

  constructor(coreOrOptions?: AgySessionCore | { sessionStore?: any }) {
    if (coreOrOptions instanceof AgySessionCore) {
      this.core = coreOrOptions;
    } else {
      this.core = new AgySessionCore(coreOrOptions);
    }
    this.v1 = new AgyAcpV1Service(this.core);
    this.v2 = new AgyAcpV2Service(this.core);
  }

  async initialize(): Promise<any> {
    return this.v1.initialize();
  }

  async initializeV1(): Promise<any> {
    return this.v1.initialize();
  }

  async initializeV2(): Promise<any> {
    return this.v2.initialize();
  }

  async newSession(params: any): Promise<any> {
    const version: ProtocolVersion = params?.protocolVersion === 2 ? 2 : 1;
    return version === 2 ? this.v2.newSession(params) : this.v1.newSession(params);
  }

  async resumeSession(
    params: any,
    notifyClient?: (update: any) => Promise<void> | void,
  ): Promise<any> {
    const version: ProtocolVersion = params?.protocolVersion === 2 ? 2 : 1;
    return version === 2
      ? this.v2.resumeSession(params, notifyClient)
      : this.v1.resumeSession(params);
  }

  async loadSession(
    params: any,
    notifyClient: (update: any) => Promise<void> | void,
  ): Promise<any> {
    return this.v1.loadSession(params, notifyClient);
  }

  async setConfigOption(params: any): Promise<any> {
    const targetSession = this.core.sessions.get(params?.sessionId);
    const version: ProtocolVersion =
      params?.protocolVersion === 2 || targetSession?.protocolVersion === 2 ? 2 : 1;
    return version === 2 ? this.v2.setConfigOption(params) : this.v1.setConfigOption(params);
  }

  async listSessions(params?: any): Promise<any> {
    return this.core.listSessions(params);
  }

  async closeSession(params: any): Promise<any> {
    return this.core.closeSession(params);
  }

  async deleteSession(params: any): Promise<any> {
    const targetSession = this.core.sessions.get(params?.sessionId);
    const version: ProtocolVersion =
      params?.protocolVersion === 2 || targetSession?.protocolVersion === 2 ? 2 : 1;
    return version === 2 ? this.v2.deleteSession(params) : this.v1.deleteSession(params);
  }

  cancelSession(params: any): void {
    this.core.cancelSession(params);
  }

  promptSession(
    params: any,
    notifyClient: (update: any) => Promise<void> | void,
    opts?: { isPreLocked?: boolean },
  ): Promise<{ stopReason: string }> {
    const targetSession = this.core.sessions.get(params?.sessionId);
    const version: ProtocolVersion =
      params?.protocolVersion === 2 ||
      (params?.protocolVersion !== 1 && targetSession?.protocolVersion === 2)
        ? 2
        : 1;
    return version === 2
      ? this.v2.promptSession(params, notifyClient, opts)
      : this.v1.promptSession(params, notifyClient);
  }
}
