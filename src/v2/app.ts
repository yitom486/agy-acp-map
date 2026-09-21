import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { AGENT_INFO } from '../core/types.ts';
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
    .onRequest(v2.methods.agent.session.delete, (ctx) => service.deleteSession(ctx.params))
    .onRequest(v2.methods.agent.session.prompt, ({ params, client }: any) => {
      const sessionId = params?.sessionId;
      const session = service.core.sessions.get(sessionId);
      if (!session) {
        throw new v2.RequestError(-32001, `unknown sessionId: ${sessionId}`);
      }
      if (session.protocolVersion !== 2) {
        throw new v2.RequestError(
          -32602,
          `Session ${sessionId} protocol mismatch: expected v${session.protocolVersion}, got v2`,
        );
      }
      if (session.busy) {
        throw new v2.RequestError(-32002, 'session is busy; wait for idle or cancel');
      }

      // Mark busy immediately so concurrent calls are rejected
      session.busy = true;

      // Start work in the next event-loop tick so the ACK response is queued on stdout before
      // any session updates from the turn, strictly adhering to canonical ACP v2 architecture.
      setTimeout(() => {
        session.busy = false;
        service
          .promptSession({ ...params, protocolVersion: 2 }, (update: any) => {
            return (client as any).notify(v2.methods.client.session.update, {
              sessionId,
              update,
            });
          })
          .catch((err: any) => {
            console.error('[ACP-V2] Background prompt turn error:', err);
          });
      }, 0);

      // In ACP v2 draft, session/prompt acknowledges receipt immediately with {}
      return {};
    })
    .onNotification(v2.methods.agent.session.cancel, (ctx) => service.cancelSession(ctx.params));
}
