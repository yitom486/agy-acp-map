import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as v1 from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { RequestError } from '@agentclientprotocol/sdk';

import {
  createMapperState,
  resetTurnState,
  mapAgyEvent,
  buildAgyUserMessage,
  richRootsFromSession,
  type MapperState,
} from './lib/map-agy-to-acp.ts';
import {
  normalizePromptBlocksSync,
  cleanupSessionStaging,
} from './lib/prompt-normalize.ts';
import {
  parseSoftDeny,
  parseSoftDenyFromEvent,
  mergeSoftDenies,
  formatSoftDenyMessage,
  type SoftDenyInfo,
} from './lib/soft-deny.ts';
import {
  extractLaunchConfig,
  applyConfigOption,
  buildAgyArgs,
  resolveSafety,
  resolveSkipPermissions,
  resolveDisableSlashCommands,
  resolvePrintTimeout,
  SAFETY_TIERS,
} from './lib/agy-args.ts';
import { discoverAgyCatalog } from './lib/agy-discovery.ts';
import { AgyProcessManager } from './lib/agy-process.ts';
import {
  SessionStore,
  sessionToRecord,
  recordLaunchFields,
  deleteOnCloseEnabled,
} from './lib/session-store.ts';

export const AGENT_INFO = {
  name: 'agy-acp',
  title: 'agy ACP (stream-json)',
  version: '0.5.0',
};

export const BRIDGE_CAPABILITIES = {
  prompt: true,
  streaming: true,
  tools: true,
  resume: true,
  permissionRoundTrip: false,
  permissionMode: 'safety_tiers',
  safetyTiers: [...SAFETY_TIERS],
  nativeCancel: false,
  cancelMode: 'SIGINT_then_KILL',
  historyReplay: false,
  dynamicConfig: 'restart',
  richContentInput: 'degrade_to_files',
  richContentOutput: 'best_effort',
  clientFilesystem: false,
  clientTerminal: false,
};

export interface SdkSession {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  createdAt: string;
  updatedAt: string;
  title?: string;
  proc: AgyProcessManager;
  mapper: MapperState;
  busy: boolean;
  cancelled: boolean;
  protocolVersion: number;
  stderrBuf: string;
  softDenies: SoftDenyInfo[];
  softDenyEmitted: boolean;
  stagedFiles: string[];
  conversationId?: string;
  model?: string;
  effort?: string;
  mode?: string;
  agent?: string;
  sandbox?: boolean;
  jsonSchema?: string;
  safety?: 'safe' | 'autonomous' | 'autonomous-unsandboxed';
  skipPermissions?: boolean;
  disableSlashCommands?: boolean;
  printTimeout?: string;
}

export class AgyAcpService {
  private sessions = new Map<string, SdkSession>();
  private sessionStore = new SessionStore();
  private catalogPromise: Promise<any> | null = null;

  constructor() {
    this.catalogPromise = discoverAgyCatalog();
  }

  private persistSession(session: SdkSession) {
    try {
      this.sessionStore.upsert(sessionToRecord(session));
    } catch {
      /* ignore */
    }
  }

  private sessionMeta(session: SdkSession) {
    const meta: Record<string, unknown> = {};
    if (session.conversationId) meta.conversationId = session.conversationId;
    if (session.model) meta.model = session.model;
    if (session.effort) meta.effort = session.effort;
    if (session.mode) meta.mode = session.mode;
    if (session.agent) meta.agent = session.agent;
    if (session.sandbox === true) meta.sandbox = true;
    if (session.jsonSchema) meta.jsonSchema = session.jsonSchema;
    if (session.safety) meta.safety = session.safety;
    if (session.printTimeout !== undefined) meta.printTimeout = session.printTimeout;
    if (session.disableSlashCommands !== undefined) {
      meta.disableSlashCommands = session.disableSlashCommands;
    }
    return Object.keys(meta).length ? meta : undefined;
  }

  async initialize() {
    const discovery = await (this.catalogPromise || discoverAgyCatalog());
    const models = discovery.availableModels || [];
    const agents = discovery.availableAgents || [];
    const configOptions = [
      ...(models.length
        ? [
            {
              id: 'model',
              name: 'Model',
              description: 'Google Antigravity model ID',
              category: 'model',
              options: models.map((m: any) => ({
                value: typeof m === 'string' ? m : m.id,
                name: typeof m === 'string' ? m : m.name || m.id,
                description: typeof m === 'string' ? undefined : m.description,
              })),
            },
          ]
        : []),
      ...(agents.length
        ? [
            {
              id: 'agent',
              name: 'Agent preset',
              description: 'Specialized agent preset',
              category: 'agent',
              options: agents.map((a: any) => ({
                value: typeof a === 'string' ? a : a.id,
                name: typeof a === 'string' ? a : a.name || a.id,
                description: typeof a === 'string' ? undefined : a.description,
              })),
            },
          ]
        : []),
    ];

    return {
      agentInfo: AGENT_INFO,
      info: AGENT_INFO,
      capabilities: { session: {} },
      bridgeCapabilities: {
        ...BRIDGE_CAPABILITIES,
        availableModels: discovery.models,
        availableAgents: discovery.agents,
        configOptions,
      },
      _meta: {
        bridgeCapabilities: BRIDGE_CAPABILITIES,
        availableModels: discovery.models,
        availableAgents: discovery.agents,
        configOptions,
      },
    };
  }

  async newSession(params: any) {
    const cwd = params?.cwd;
    if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new RequestError(-32602, 'cwd must be an absolute path');
    }

    const launch = extractLaunchConfig(params);
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const richRoots = richRootsFromSession({
      cwd,
      additionalDirectories: params?.additionalDirectories,
    });
    const mapper = createMapperState(richRoots);
    if (launch.conversationId) {
      mapper.conversationId = launch.conversationId;
    }

    const session: SdkSession = {
      sessionId,
      cwd,
      additionalDirectories: params?.additionalDirectories,
      createdAt: now,
      updatedAt: now,
      title: undefined,
      proc: new AgyProcessManager(),
      mapper,
      busy: false,
      cancelled: false,
      protocolVersion: 2,
      stderrBuf: '',
      softDenies: [],
      softDenyEmitted: false,
      stagedFiles: [],
      conversationId: launch.conversationId,
      model: launch.model,
      effort: launch.effort,
      mode: launch.mode,
      agent: launch.agent,
      sandbox: launch.sandbox,
      jsonSchema: launch.jsonSchema,
      safety: launch.safety,
      skipPermissions: launch.skipPermissions,
      disableSlashCommands: launch.disableSlashCommands,
      printTimeout: launch.printTimeout,
    };

    this.sessions.set(sessionId, session);
    this.persistSession(session);

    const meta = this.sessionMeta(session);
    return {
      sessionId,
      ...(meta ? { _meta: meta } : {}),
    };
  }

  async listSessions(params?: any) {
    const filterCwd = params?.cwd;
    const disk = this.sessionStore.list(filterCwd);
    const diskById = new Map(disk.map((r) => [r.sessionId, r]));

    const out: any[] = [];
    for (const [id, s] of this.sessions.entries()) {
      if (filterCwd && s.cwd !== filterCwd) continue;
      out.push({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title,
        updatedAt: s.updatedAt,
        ...(s.additionalDirectories?.length ? { additionalDirectories: s.additionalDirectories } : {}),
        ...(s.conversationId ? { conversationId: s.conversationId } : {}),
        _meta: this.sessionMeta(s),
      });
      diskById.delete(id);
    }

    for (const r of diskById.values()) {
      out.push({
        sessionId: r.sessionId,
        cwd: r.cwd,
        title: r.title,
        updatedAt: r.updatedAt,
        ...(r.additionalDirectories?.length ? { additionalDirectories: r.additionalDirectories } : {}),
        ...(r.conversationId ? { conversationId: r.conversationId } : {}),
        _meta: r.model ? { model: r.model, conversationId: r.conversationId } : undefined,
      });
    }

    return { sessions: out };
  }

  async closeSession(params: any) {
    const sessionId = params?.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RequestError(-32001, `unknown sessionId: ${sessionId}`);
    }

    await session.proc.kill();
    cleanupSessionStaging(session.cwd);
    session.stagedFiles = [];
    this.sessions.delete(sessionId);

    if (deleteOnCloseEnabled()) {
      this.sessionStore.delete(sessionId);
    }
    return {};
  }

  cancelSession(params: any) {
    const sessionId = params?.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelled = true;
    session.proc.kill();
  }

  async promptSession(
    params: any,
    notifyClient: (update: any) => Promise<void> | void,
  ): Promise<{ stopReason: string }> {
    const sessionId = params?.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RequestError(-32001, `unknown sessionId: ${sessionId}`);
    }
    if (session.busy) {
      throw new RequestError(-32002, 'session is busy; wait for idle or cancel');
    }

    const { text, notes, stagedFiles } = normalizePromptBlocksSync(params?.prompt || [], {
      cwd: session.cwd,
    });
    if (!text.trim()) {
      throw new RequestError(-32602, 'empty prompt after flattening content blocks', { notes });
    }

    if (stagedFiles.length) {
      session.stagedFiles.push(...stagedFiles);
    }

    const messageId = `msg_user_${randomUUID().slice(0, 8)}`;
    await notifyClient({
      sessionUpdate: 'user_message',
      messageId,
      content: [{ type: 'text', text }],
    });
    await notifyClient({
      sessionUpdate: 'state_update',
      state: 'running',
    });

    session.busy = true;
    session.cancelled = false;
    session.stderrBuf = '';
    session.softDenies = [];
    session.softDenyEmitted = false;
    session.mapper = resetTurnState(session.mapper);
    session.updatedAt = new Date().toISOString();

    return new Promise<{ stopReason: string }>(async (resolve) => {
      const finish = async (stopReason: string) => {
        if (!session.busy) return;
        session.busy = false;

        // Check if soft-deny happened and emit note
        if (!session.softDenyEmitted && session.softDenies.length) {
          session.softDenyEmitted = true;
          const msg = formatSoftDenyMessage(session.softDenies);
          if (msg) {
            await notifyClient({
              sessionUpdate: 'agent_message_chunk',
              messageId: `msg_agent_soft_deny_${Date.now()}`,
              content: { type: 'text', text: '\n\n' + msg },
            });
          }
        }

        await notifyClient({
          sessionUpdate: 'state_update',
          state: 'idle',
          stopReason,
        });

        this.persistSession(session);
        resolve({ stopReason });
      };

      const roots = richRootsFromSession({
        cwd: session.cwd,
        additionalDirectories: session.additionalDirectories,
      });

      const onEvent = async (event: any) => {
        const fromEvt = parseSoftDenyFromEvent(event);
        if (fromEvt.length) {
          session.softDenies = mergeSoftDenies(session.softDenies, fromEvt);
        }

        const { notifications, state } = mapAgyEvent(session.sessionId, event, session.mapper);
        session.mapper = state;
        if (state.conversationId && state.conversationId !== session.conversationId) {
          session.conversationId = state.conversationId;
          this.persistSession(session);
        }

        for (const n of notifications) {
          const u = n.params?.update as any;
          if (u) {
            await notifyClient(u);
            if (u.sessionUpdate === 'state_update' && u.state === 'idle') {
              finish(u.stopReason || 'end_turn');
              return;
            }
          }
        }
      };

      const onError = async (err: Error) => {
        await notifyClient({
          sessionUpdate: 'agent_message_chunk',
          messageId: `msg_agent_err_${Date.now()}`,
          content: { type: 'text', text: `\n[agy error] ${err.message}` },
        });
        finish('end_turn');
      };

      const onStderr = (line: string) => {
        session.stderrBuf += line + '\n';
        const parsed = parseSoftDeny(line);
        if (parsed.length) {
          session.softDenies = mergeSoftDenies(session.softDenies, parsed);
        }
      };

      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (session.busy) {
          finish(session.cancelled ? 'cancelled' : 'end_turn');
        }
      };

      const skip = resolveSkipPermissions(session);
      const disableSlash = resolveDisableSlashCommands(session);
      const printTimeout = resolvePrintTimeout(session);
      const safety = resolveSafety(session);

      const args = buildAgyArgs({
        cwd: session.cwd,
        additionalDirectories: session.additionalDirectories,
        conversationId: session.conversationId || session.mapper?.conversationId,
        model: session.model,
        effort: session.effort,
        mode: session.mode,
        agent: session.agent,
        sandbox: session.sandbox,
        jsonSchema: session.jsonSchema,
        safety: safety.safety,
        skipPermissions: skip,
        disableSlashCommands: disableSlash,
        printTimeout,
      });

      const bin = process.env.AGY_BIN || 'agy';

      try {
        if (!session.proc.isWritable()) {
          await session.proc.spawn({
            bin,
            args,
            cwd: session.cwd,
            onEvent,
            onError,
            onStderr,
            onExit,
          });
        }

        const line = JSON.stringify(buildAgyUserMessage(text));
        session.proc.writeLine(line);
      } catch (err: any) {
        onError(err);
      }
    });
  }
}

/**
 * Creates an ACP v1 agent app wrapped with official @agentclientprotocol/sdk.
 */
export function createAcpV1App(service: AgyAcpService = new AgyAcpService()): v1.AgentApp {
  return v1
    .agent({ name: AGENT_INFO.name })
    .onRequest(v1.methods.agent.initialize, async () => {
      const init = await service.initialize();
      return {
        protocolVersion: 1,
        agentCapabilities: { loadSession: false },
        ...init,
      } as any;
    })
    .onRequest(v1.methods.agent.session.new, (ctx) => service.newSession(ctx.params))
    .onRequest(v1.methods.agent.session.list, (ctx) => service.listSessions(ctx.params))
    .onRequest(v1.methods.agent.session.close, (ctx) => service.closeSession(ctx.params))
    .onRequest(v1.methods.agent.session.prompt, async (ctx) => {
      return (await service.promptSession(ctx.params, (update) => {
        return ctx.client.notify(v1.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update,
        });
      })) as any;
    })
    .onNotification(v1.methods.agent.session.cancel, (ctx) => service.cancelSession(ctx.params));
}

/**
 * Creates an ACP v2 agent app wrapped with official @agentclientprotocol/sdk.
 */
export function createAcpV2App(service: AgyAcpService = new AgyAcpService()): v2.AgentApp {
  return v2
    .agent({ name: AGENT_INFO.name })
    .onRequest(v2.methods.agent.initialize, async () => {
      const init = await service.initialize();
      return {
        protocolVersion: 2,
        ...init,
      } as any;
    })
    .onRequest(v2.methods.agent.session.new, (ctx) => service.newSession(ctx.params))
    .onRequest(v2.methods.agent.session.list, (ctx) => service.listSessions(ctx.params))
    .onRequest(v2.methods.agent.session.close, (ctx) => service.closeSession(ctx.params))
    .onRequest(v2.methods.agent.session.prompt, async (ctx) => {
      return (await service.promptSession(ctx.params, (update) => {
        return ctx.client.notify(v2.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update,
        });
      })) as any;
    })
    .onNotification(v2.methods.agent.session.cancel, (ctx) => service.cancelSession(ctx.params));
}

/**
 * Dual router supporting both ACP v1 and v2 clients automatically.
 */
export function createDualAcpApp(service: AgyAcpService = new AgyAcpService()): v2.AgentProtocolRouter {
  return v2.agentProtocolRouter().withV1(createAcpV1App(service)).withV2(createAcpV2App(service));
}
