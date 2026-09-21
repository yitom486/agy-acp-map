import * as v1 from '@agentclientprotocol/sdk';
import { AGENT_INFO } from '../core/types.ts';
import { formatUpdateForProtocol } from '../lib/map-agy-to-acp.ts';
import { AgyAcpV1Service } from './adapter.ts';

/**
 * Creates an ACP v1 agent app wrapped with official @agentclientprotocol/sdk.
 */
export function createAcpV1App(service: AgyAcpV1Service | any = new AgyAcpV1Service()): v1.AgentApp {
  return v1
    .agent({ name: AGENT_INFO.name })
    .onRequest(v1.methods.agent.initialize, () => {
      if (typeof service.initializeV1 === 'function') {
        return service.initializeV1() as any;
      }
      return service.initialize() as any;
    })
    .onRequest(v1.methods.agent.session.new, (ctx) =>
      service.newSession({ ...ctx.params, protocolVersion: 1 }) as any,
    )
    .onRequest(v1.methods.agent.session.load, (ctx) =>
      service.resumeSession({ ...ctx.params, protocolVersion: 1 }) as any,
    )
    .onRequest(v1.methods.agent.session.resume, (ctx) =>
      service.resumeSession({ ...ctx.params, protocolVersion: 1 }) as any,
    )
    .onRequest(v1.methods.agent.session.setConfigOption, (ctx) =>
      service.setConfigOption({ ...ctx.params, protocolVersion: 1 }) as any,
    )
    .onRequest(v1.methods.agent.session.list, (ctx) => service.listSessions(ctx.params))
    .onRequest(v1.methods.agent.session.close, (ctx) => service.closeSession(ctx.params))
    .onRequest(v1.methods.agent.session.prompt, async (ctx: any) => {
      return (await service.promptSession({ ...ctx.params, protocolVersion: 1 }, (update: any) => {
        const formatted = formatUpdateForProtocol(update, 1);
        if (formatted) {
          return (ctx.client as any).notify(v1.methods.client.session.update, {
            sessionId: ctx.params.sessionId,
            update: formatted,
          });
        }
      })) as any;
    })
    .onNotification(v1.methods.agent.session.cancel, (ctx) => service.cancelSession(ctx.params));
}
