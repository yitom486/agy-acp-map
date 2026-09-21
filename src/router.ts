import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { createAcpV1App } from './v1/app.ts';
import { createAcpV2App } from './v2/app.ts';
import { AgySessionCore } from './core/session-core.ts';
import { AgyAcpV1Service } from './v1/adapter.ts';
import { AgyAcpV2Service } from './v2/adapter.ts';

/**
 * Dual router supporting both ACP v1 and v2 clients automatically.
 * Shares the underlying AgySessionCore so sessions created in v1
 * or v2 share the same runtime store and process supervisors.
 */
export function createDualAcpApp(
  sharedServiceOrCore?: any,
): v2.AgentProtocolRouter {
  let v1App;
  let v2App;

  if (
    sharedServiceOrCore &&
    typeof sharedServiceOrCore.initializeV1 === 'function' &&
    typeof sharedServiceOrCore.initializeV2 === 'function'
  ) {
    v1App = createAcpV1App(sharedServiceOrCore.v1 ?? sharedServiceOrCore);
    v2App = createAcpV2App(sharedServiceOrCore.v2 ?? sharedServiceOrCore);
  } else if (sharedServiceOrCore instanceof AgySessionCore) {
    v1App = createAcpV1App(new AgyAcpV1Service(sharedServiceOrCore));
    v2App = createAcpV2App(new AgyAcpV2Service(sharedServiceOrCore));
  } else {
    const core = new AgySessionCore();
    v1App = createAcpV1App(new AgyAcpV1Service(core));
    v2App = createAcpV2App(new AgyAcpV2Service(core));
  }

  return v2.agentProtocolRouter().withV1(v1App).withV2(v2App);
}
