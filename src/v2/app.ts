import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { AGENT_INFO } from '../core/types.ts';
import { formatUpdateForProtocol } from '../lib/map-agy-to-acp.ts';
import { AgyAcpV2Service } from './adapter.ts';

/**
 * Creates an ACP v2 agent app wrapped with official @agentclientprotocol/sdk.
 */
export function createAcpV2App(service: AgyAcpV2Service | any = new AgyAcpV2Service()): v2.AgentApp {
  return v2
    .agent({ name: AGENT_INFO.name })
    .onRequest(v2.methods.agent.initialize, () => {
      if (typeof service.initializeV2 === 'function') {
        return service.initializeV2() as any;
      }
      return service.initialize() as any;
    })
    .onRequest(v2.methods.agent.session.new, (ctx) =>
      service.newSession({ ...ctx.params, protocolVersion: 2 }) as any,
    )
    .onRequest(v2.methods.agent.session.resume, (ctx) =>
      service.resumeSession({ ...ctx.params, protocolVersion: 2 }) as any,
    )
    .onRequest(v2.methods.agent.session.setConfigOption, (ctx) =>
      service.setConfigOption({ ...ctx.params, protocolVersion: 2 }) as any,
    )
    .onRequest(v2.methods.agent.session.list, (ctx) => service.listSessions(ctx.params))
    .onRequest(v2.methods.agent.session.close, (ctx) => service.closeSession(ctx.params))
    .onRequest(v2.methods.agent.session.prompt, async (ctx: any) => {
      return (await service.promptSession({ ...ctx.params, protocolVersion: 2 }, (update: any) => {
        const formatted = formatUpdateForProtocol(update, 2);
        if (formatted) {
          return (ctx.client as any).notify(v2.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: formatted,
          });
        }
      })) as any;
    })
    .onNotification(v2.methods.agent.session.cancel, (ctx) => service.cancelSession(ctx.params));
}
