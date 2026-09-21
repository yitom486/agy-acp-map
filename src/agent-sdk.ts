import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as v1 from '@agentclientprotocol/sdk';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { RequestError } from '@agentclientprotocol/sdk';

import {
  createMapperState,
  resetTurnState,
  mapAgyEvent,
  formatUpdateForProtocol,
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
import { discoverAgyCatalog, type DiscoveryResult } from './lib/agy-discovery.ts';
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
  version: '0.1.3',
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

type ProtocolVersion = 1 | 2;
type ProtocolConfigOption = v1.SessionConfigOption | v2.SessionConfigOption;

const V1_AGENT_CAPABILITIES = {
  loadSession: true,
  sessionCapabilities: {
    list: {},
    resume: {},
    close: {},
    additionalDirectories: {},
  },
};

const V2_AGENT_CAPABILITIES = {
  session: {
    additionalDirectories: {},
  },
};

type CatalogChoice = {
  value: string;
  name: string;
  description?: string;
};

function catalogChoices(items: unknown, currentValue?: string): CatalogChoice[] {
  const choices: CatalogChoice[] = [];
  const seen = new Set<string>();

  if (Array.isArray(items)) {
    for (const item of items) {
      let value: string | undefined;
      let name: string | undefined;
      let description: string | undefined;

      if (typeof item === 'string') {
        value = item.trim();
        name = value;
      } else if (item && typeof item === 'object') {
        const candidate = item as Record<string, unknown>;
        value =
          typeof candidate.id === 'string'
            ? candidate.id.trim()
            : typeof candidate.value === 'string'
              ? candidate.value.trim()
              : undefined;
        name = typeof candidate.name === 'string' ? candidate.name.trim() : value;
        description =
          typeof candidate.description === 'string' && candidate.description.trim()
            ? candidate.description.trim()
            : undefined;
      }

      if (!value || seen.has(value)) continue;
      seen.add(value);
      choices.push({ value, name: name || value, ...(description ? { description } : {}) });
    }
  }

  // A resumed session may contain a model/agent that the current CLI catalog
  // no longer reports. Keep that value selectable so the session response
  // remains internally consistent and does not lose the user's selection.
  if (currentValue && !seen.has(currentValue)) {
    choices.unshift({
      value: currentValue,
      name: currentValue,
      description: 'Current session value',
    });
  }

  return choices;
}

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
  protocolVersion: ProtocolVersion;
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

/**
 * Sequential FIFO execution queue to eliminate notification ordering races.
 */
class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(fn: () => Promise<void> | void): Promise<void> {
    const next = this.tail.then(() => fn()).catch((err) => {
      console.error('[AgyAcpService Queue Error]', err);
    });
    this.tail = next;
    return next;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

export class AgyAcpService {
  private sessions = new Map<string, SdkSession>();
  private sessionStore = new SessionStore();
  private catalogPromise: Promise<any> | null = null;

  constructor() {
    // Discovery is lazy to avoid spawning background subprocesses on instantiation
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

  private async getDiscovery(): Promise<DiscoveryResult> {
    if (!this.catalogPromise) {
      this.catalogPromise = discoverAgyCatalog();
    }
    return this.catalogPromise;
  }

  private applyCatalogDefaults(session: SdkSession, discovery: DiscoveryResult): void {
    const models = catalogChoices(discovery.availableModels, session.model);
    const agents = catalogChoices(discovery.availableAgents, session.agent);

    if (!session.model && models.length) session.model = models[0].value;
    if (!session.agent && agents.length) session.agent = agents[0].value;
  }

  /**
   * Build the standard ACP session configuration shape.
   *
   * ACP v1 calls the selector key `id`; ACP v2 calls it `configId`.
   * Keeping this difference at the protocol boundary lets the core session
   * state remain version-neutral while both wire protocols stay conformant.
   */
  private buildConfigOptions(
    discovery: DiscoveryResult,
    session?: Pick<SdkSession, 'model' | 'agent'>,
    protocolVersion: ProtocolVersion = 2,
  ): ProtocolConfigOption[] {
    const models = catalogChoices(discovery.availableModels, session?.model);
    const agents = catalogChoices(discovery.availableAgents, session?.agent);
    const options: ProtocolConfigOption[] = [];

    if (models.length) {
      const select = {
        type: 'select' as const,
        name: 'Model',
        description: 'Google Antigravity model ID',
        category: 'model',
        currentValue: session?.model || models[0].value,
        options: models,
      };
      options.push(
        (protocolVersion === 1
          ? { ...select, id: 'model' }
          : { ...select, configId: 'model' }) as ProtocolConfigOption,
      );
    }

    if (agents.length) {
      const select = {
        type: 'select' as const,
        name: 'Agent preset',
        description: 'Specialized agent preset',
        // `agent` is not a reserved ACP category, so use the extension
        // namespace instead of claiming a future standard category.
        category: '_agent',
        currentValue: session?.agent || agents[0].value,
        options: agents,
      };
      options.push(
        (protocolVersion === 1
          ? { ...select, id: 'agent' }
          : { ...select, configId: 'agent' }) as ProtocolConfigOption,
      );
    }

    return options;
  }

  async initialize() {
    const discovery = await this.getDiscovery();
    const configOptions = this.buildConfigOptions(discovery);

    return {
      agentInfo: AGENT_INFO,
      info: AGENT_INFO,
      availableModels: discovery.availableModels,
      availableAgents: discovery.availableAgents,
      bridgeCapabilities: {
        ...BRIDGE_CAPABILITIES,
        availableModels: discovery.availableModels,
        availableAgents: discovery.availableAgents,
        configOptions,
      },
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

  async initializeV1() {
    const init = await this.initialize();
    return {
      protocolVersion: 1,
      agentInfo: init.agentInfo,
      agentCapabilities: V1_AGENT_CAPABILITIES,
      _meta: init._meta,
    };
  }

  async initializeV2() {
    const init = await this.initialize();
    return {
      protocolVersion: 2,
      info: init.info,
      capabilities: V2_AGENT_CAPABILITIES,
      _meta: init._meta,
    };
  }

  async newSession(params: any) {
    const cwd = params?.cwd;
    if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new RequestError(-32602, 'cwd must be an absolute path');
    }

    const protocolVersion: ProtocolVersion = params?.protocolVersion === 1 ? 1 : 2;
    const launch = extractLaunchConfig(params);
    const discovery = await this.getDiscovery();
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
      protocolVersion,
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

    this.applyCatalogDefaults(session, discovery);
    this.sessions.set(sessionId, session);
    this.persistSession(session);

    const meta = this.sessionMeta(session);
    return {
      sessionId,
      configOptions: this.buildConfigOptions(discovery, session, protocolVersion),
      ...(meta ? { _meta: meta } : {}),
    };
  }

  async resumeSession(params: any) {
    const sessionId = params?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') {
      throw new RequestError(-32602, 'sessionId is required for session/resume');
    }

    const requestedProtocolVersion: ProtocolVersion = params?.protocolVersion === 1 ? 1 : 2;
    let session = this.sessions.get(sessionId);
    if (!session) {
      const record = this.sessionStore.get(sessionId);
      if (!record) {
        throw new RequestError(-32001, `Session not found: ${sessionId}`);
      }

      const cwd = record.cwd || params?.cwd || process.cwd();
      const richRoots = richRootsFromSession({
        cwd,
        additionalDirectories: record.additionalDirectories,
      });
      const mapper = createMapperState(richRoots);
      if (record.conversationId) {
        mapper.conversationId = record.conversationId;
      }

      session = {
        sessionId,
        cwd,
        additionalDirectories: record.additionalDirectories,
        createdAt: record.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: record.title,
        proc: new AgyProcessManager(),
        mapper,
        busy: false,
        cancelled: false,
        protocolVersion: requestedProtocolVersion,
        stderrBuf: '',
        softDenies: [],
        softDenyEmitted: false,
        stagedFiles: [],
        conversationId: record.conversationId,
        model: record.model,
        effort: record.effort,
        mode: record.mode,
        agent: record.agent,
        sandbox: record.sandbox,
        jsonSchema: record.jsonSchema,
        safety: record.safety as any,
        skipPermissions: (record as any).skipPermissions,
        disableSlashCommands: record.disableSlashCommands,
        printTimeout: record.printTimeout,
      };

      this.sessions.set(sessionId, session);
    } else {
      session.protocolVersion = requestedProtocolVersion;
      session.updatedAt = new Date().toISOString();
    }

    const discovery = await this.getDiscovery();
    this.applyCatalogDefaults(session, discovery);
    this.persistSession(session);

    const meta = this.sessionMeta(session);
    return {
      configOptions: this.buildConfigOptions(discovery, session, session.protocolVersion),
      ...(meta ? { _meta: meta } : {}),
    };
  }

  async setConfigOption(params: any) {
    const sessionId = params?.sessionId;
    const configId = params?.configId || params?.id;
    const rawValue = params?.value;
    const value =
      rawValue && typeof rawValue === 'object' && 'value' in rawValue
        ? (rawValue as { value: unknown }).value
        : rawValue;

    if (!sessionId) {
      throw new RequestError(-32602, 'sessionId is required');
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RequestError(-32001, `unknown sessionId: ${sessionId}`);
    }

    if (typeof configId !== 'string' || value === undefined) {
      throw new RequestError(-32602, 'configId and value are required');
    }

    const protocolVersion: ProtocolVersion =
      params?.protocolVersion === 1 || session.protocolVersion === 1 ? 1 : 2;
    const discovery = await this.getDiscovery();
    this.applyCatalogDefaults(session, discovery);
    const before = this.buildConfigOptions(discovery, session, protocolVersion);
    const selected = before.find((option) => {
      const candidate = option as any;
      return candidate.configId === configId || candidate.id === configId;
    }) as any;
    if (!selected) {
      throw new RequestError(-32602, `unsupported configId: ${configId}`);
    }

    const allowedValues = Array.isArray(selected.options)
      ? selected.options.map((option: any) => option.value)
      : [];
    if (!allowedValues.includes(value)) {
      throw new RequestError(-32602, `invalid value for configId: ${configId}`);
    }

    const applied = applyConfigOption(session as any, configId, value);
    if (!applied.ok) {
      throw new RequestError(-32602, applied.error || `unsupported configId: ${configId}`);
    }

    session.updatedAt = new Date().toISOString();
    this.persistSession(session);
    await session.proc.kill();

    const configOptions = this.buildConfigOptions(discovery, session, protocolVersion);

    return {
      configOptions,
      _meta: this.sessionMeta(session),
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

  promptSession(
    params: any,
    notifyClient: (update: any) => Promise<void> | void,
  ): Promise<{ stopReason: string }> {
    const sessionId = params?.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.reject(new RequestError(-32001, `unknown sessionId: ${sessionId}`));
    }
    if (session.busy) {
      return Promise.reject(new RequestError(-32002, 'session is busy; wait for idle or cancel'));
    }

    const { text, notes, stagedFiles } = normalizePromptBlocksSync(params?.prompt || [], {
      cwd: session.cwd,
    });
    if (!text.trim()) {
      return Promise.reject(
        new RequestError(-32602, 'empty prompt after flattening content blocks', { notes }),
      );
    }

    if (stagedFiles.length) {
      session.stagedFiles.push(...stagedFiles);
    }

    const queue = new AsyncSerialQueue();

    session.busy = true;
    session.cancelled = false;
    session.stderrBuf = '';
    session.softDenies = [];
    session.softDenyEmitted = false;
    session.mapper = resetTurnState(session.mapper);
    session.updatedAt = new Date().toISOString();

    console.error(`[ACP-SDK] promptSession: sid: ${sessionId}, isWritable: ${session.proc.isWritable()}, model: ${session.model}, text: "${text.slice(0, 60)}"`);

    const messageId = `msg_user_${randomUUID().slice(0, 8)}`;
    queue.enqueue(() =>
      notifyClient(
        formatUpdateForProtocol(
          {
            sessionUpdate: 'user_message',
            messageId,
            content: [{ type: 'text', text }],
          },
          session.protocolVersion,
        ),
      ),
    );

    if (session.protocolVersion >= 2) {
      queue.enqueue(() =>
        notifyClient({
          sessionUpdate: 'state_update',
          state: 'running',
        }),
      );
    }

    return new Promise<{ stopReason: string }>((resolve) => {
      let isSettled = false;

      const finish = (stopReason: string) => {
        if (!session.busy || isSettled) return;
        isSettled = true;
        session.busy = false;

        console.error(`[ACP-SDK] finish: ending turn for sid: ${sessionId} with stopReason: ${stopReason}`);

        queue.enqueue(async () => {
          // Check if soft-deny happened and emit note
          if (!session.softDenyEmitted && session.softDenies.length) {
            session.softDenyEmitted = true;
            const msg = formatSoftDenyMessage(session.softDenies);
            if (msg) {
              await notifyClient(
                formatUpdateForProtocol(
                  {
                    sessionUpdate: 'agent_message_chunk',
                    messageId: `msg_agent_soft_deny_${Date.now()}`,
                    content: { type: 'text', text: '\n\n' + msg },
                  },
                  session.protocolVersion,
                ),
              );
            }
          }

          if (session.protocolVersion >= 2) {
            await notifyClient({
              sessionUpdate: 'state_update',
              state: 'idle',
              stopReason,
            });
          }

          this.persistSession(session);

          // Auto-clean turn staged files unless explicitly requested to keep
          if (process.env.AGY_ACP_KEEP_STAGING !== '1' && session.stagedFiles.length) {
            for (const f of session.stagedFiles) {
              try {
                if (fs.existsSync(f)) fs.unlinkSync(f);
              } catch {}
            }
            session.stagedFiles = [];
          }

          resolve({ stopReason });
        });
      };

      const onEvent = (event: any) => {
        queue.enqueue(async () => {
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
              const formatted = formatUpdateForProtocol(u, session.protocolVersion);
              await notifyClient(formatted);
              if (u.sessionUpdate === 'state_update' && u.state === 'idle') {
                finish(u.stopReason || 'end_turn');
                return;
              }
            }
          }
        });
      };

      const onError = (err: Error) => {
        console.error(`[ACP-SDK] onError (sid: ${sessionId}):`, err.message);
        queue.enqueue(async () => {
          await notifyClient(
            formatUpdateForProtocol(
              {
                sessionUpdate: 'agent_message_chunk',
                messageId: `msg_agent_err_${Date.now()}`,
                content: { type: 'text', text: `\n[agy error] ${err.message}` },
              },
              session.protocolVersion,
            ),
          );
          finish('end_turn');
        });
      };

      const onStderr = (line: string) => {
        session.stderrBuf += line + '\n';
        const parsed = parseSoftDeny(line);
        if (parsed.length) {
          session.softDenies = mergeSoftDenies(session.softDenies, parsed);
        }
      };

      const onExit = (code: number | null) => {
        console.error(`[ACP-SDK] onExit (sid: ${sessionId}): code: ${code}`);
        if (session.busy && !isSettled) {
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

      let bin = process.env.AGY_BIN || 'agy';
      if (bin === 'agy' || bin === 'agy.exe') {
        const geminiBin = path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
        if (fs.existsSync(geminiBin)) {
          bin = geminiBin;
        }
      }

      let execBin = bin;
      let execArgs = args;
      if (/\.(js|cjs|mjs|ts)$/i.test(bin)) {
        execBin = process.execPath;
        execArgs = [bin, ...args];
      }

      (async () => {
        try {
          if (!session.proc.isWritable()) {
            console.error(`[ACP-SDK] session process not writable -> spawning new process for sid: ${sessionId}`);
            await session.proc.spawn({
              bin: execBin,
              args: execArgs,
              cwd: session.cwd,
              onEvent,
              onError,
              onStderr,
              onExit,
            });
          } else {
            console.error(`[ACP-SDK] session process writable -> updating callbacks for consecutive turn, sid: ${sessionId}`);
            session.proc.setCallbacks({
              onEvent,
              onError,
              onStderr,
              onExit,
            });
          }

          const line = JSON.stringify(buildAgyUserMessage(text));
          console.error(`[ACP-SDK] writing user message to stdin: len: ${line.length}`);
          session.proc.writeLine(line);
        } catch (err: any) {
          onError(err);
        }
      })();
    });
  }
}

/**
 * Creates an ACP v1 agent app wrapped with official @agentclientprotocol/sdk.
 */
export function createAcpV1App(service: AgyAcpService = new AgyAcpService()): v1.AgentApp {
  return v1
    .agent({ name: AGENT_INFO.name })
    .onRequest(v1.methods.agent.initialize, () => service.initializeV1() as any)
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
      return (await service.promptSession(ctx.params, (update) => {
        return (ctx.client as any).notify(v1.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: formatUpdateForProtocol(update, 1),
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
    .onRequest(v2.methods.agent.initialize, () => service.initializeV2() as any)
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
      return (await service.promptSession(ctx.params, (update) => {
        return (ctx.client as any).notify(v2.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: formatUpdateForProtocol(update, 2),
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
