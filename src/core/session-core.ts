import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { RequestError } from '@agentclientprotocol/sdk';

import {
  createMapperState,
  resetTurnState,
  mapAgyEvent,
  buildAgyUserMessage,
  richRootsFromSession,
} from '../lib/map-agy-to-acp.ts';
import {
  normalizePromptBlocksSync,
  cleanupSessionStaging,
} from '../lib/prompt-normalize.ts';
import {
  parseSoftDeny,
  parseSoftDenyFromEvent,
  mergeSoftDenies,
  formatSoftDenyMessage,
} from '../lib/soft-deny.ts';
import {
  extractLaunchConfig,
  applyConfigOption,
  buildAgyArgs,
  resolveSafety,
  resolveSkipPermissions,
  resolveDisableSlashCommands,
  resolvePrintTimeout,
} from '../lib/agy-args.ts';
import { discoverAgyCatalog, type DiscoveryResult } from '../lib/agy-discovery.ts';
import { AgyProcessManager } from '../lib/agy-process.ts';
import {
  SessionStore,
  sessionToRecord,
  deleteOnCloseEnabled,
} from '../lib/session-store.ts';
import {
  type SdkSession,
  type ProtocolVersion,
  catalogChoices,
  AsyncSerialQueue,
} from './types.ts';

export class AgySessionCore {
  readonly sessions = new Map<string, SdkSession>();
  readonly sessionStore = new SessionStore();
  private catalogPromise: Promise<DiscoveryResult> | null = null;

  async getDiscovery(): Promise<DiscoveryResult> {
    if (!this.catalogPromise) {
      this.catalogPromise = discoverAgyCatalog();
    }
    return this.catalogPromise;
  }

  persistSession(session: SdkSession): void {
    try {
      this.sessionStore.upsert(sessionToRecord(session));
    } catch {
      /* ignore */
    }
  }

  sessionMeta(session: SdkSession): Record<string, unknown> | undefined {
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

  applyCatalogDefaults(session: SdkSession, discovery: DiscoveryResult): void {
    const models = catalogChoices(discovery.availableModels, session.model);
    const agents = catalogChoices(discovery.availableAgents, session.agent);

    if (!session.model && models.length) session.model = models[0].value;
    if (!session.agent && agents.length) session.agent = agents[0].value;
  }

  async createSession(
    params: any,
    protocolVersion: ProtocolVersion = 1,
  ): Promise<{ session: SdkSession; discovery: DiscoveryResult; meta?: Record<string, unknown> }> {
    const cwd = params?.cwd;
    if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new RequestError(-32602, 'cwd must be an absolute path');
    }

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
      protocolVersion, // Bound permanently upon creation
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

    return {
      session,
      discovery,
      meta: this.sessionMeta(session),
    };
  }

  async resumeSession(
    params: any,
    protocolVersion: ProtocolVersion = 1,
  ): Promise<{ session: SdkSession; discovery: DiscoveryResult; meta?: Record<string, unknown> }> {
    const sessionId = params?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') {
      throw new RequestError(-32602, 'sessionId is required for session/resume');
    }

    let session = this.sessions.get(sessionId);
    if (!session) {
      const record = this.sessionStore.get(sessionId);
      if (!record) {
        throw new RequestError(-32001, `Session not found: ${sessionId}`);
      }

      const recordedVersion = record.protocolVersion ?? protocolVersion;
      if (recordedVersion !== protocolVersion) {
        throw new RequestError(
          -32602,
          `Session ${sessionId} was created with ACP v${recordedVersion} and cannot be resumed with v${protocolVersion}`,
        );
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
        protocolVersion: recordedVersion,
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
      if (session.protocolVersion !== protocolVersion) {
        throw new RequestError(
          -32602,
          `Session ${sessionId} was created with ACP v${session.protocolVersion} and cannot be resumed with v${protocolVersion}`,
        );
      }
      session.updatedAt = new Date().toISOString();
    }

    const discovery = await this.getDiscovery();
    this.applyCatalogDefaults(session, discovery);
    this.persistSession(session);

    return {
      session,
      discovery,
      meta: this.sessionMeta(session),
    };
  }

  async updateConfigOption(
    params: any,
    protocolVersion: ProtocolVersion = 1,
    buildOptionsFn: (discovery: DiscoveryResult, session?: Pick<SdkSession, 'model' | 'agent'>) => any[],
  ): Promise<{ session: SdkSession; discovery: DiscoveryResult; configOptions: any[]; meta?: Record<string, unknown> }> {
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

    if (session.protocolVersion !== protocolVersion) {
      throw new RequestError(
        -32602,
        `Session ${sessionId} was created with ACP v${session.protocolVersion} and cannot be modified with v${protocolVersion}`,
      );
    }

    if (typeof configId !== 'string' || value === undefined) {
      throw new RequestError(-32602, 'configId and value are required');
    }

    const discovery = await this.getDiscovery();
    this.applyCatalogDefaults(session, discovery);
    const before = buildOptionsFn(discovery, session);
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

    const configOptions = buildOptionsFn(discovery, session);

    return {
      session,
      discovery,
      configOptions,
      meta: this.sessionMeta(session),
    };
  }

  async listSessions(params?: any): Promise<{ sessions: any[] }> {
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

  async closeSession(params: any): Promise<{}> {
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

  cancelSession(params: any): void {
    const sessionId = params?.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.cancelled = true;
    session.proc.kill();
  }

  promptTurn(
    params: any,
    protocolVersion: ProtocolVersion,
    notifyClient: (update: any) => Promise<void> | void,
  ): Promise<{ stopReason: string }> {
    const sessionId = params?.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) {
      return Promise.reject(new RequestError(-32001, `unknown sessionId: ${sessionId}`));
    }
    if (session.protocolVersion !== protocolVersion) {
      return Promise.reject(
        new RequestError(
          -32602,
          `Session ${sessionId} protocol mismatch: expected v${session.protocolVersion}, got v${protocolVersion}`,
        ),
      );
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

    console.error(
      `[ACP-SDK] promptTurn: sid: ${sessionId}, v: ${protocolVersion}, isWritable: ${session.proc.isWritable()}, model: ${session.model}, text: "${text.slice(0, 60)}"`,
    );

    const messageId = `msg_user_${randomUUID().slice(0, 8)}`;
    queue.enqueue(async () => {
      await notifyClient({
        sessionUpdate: 'user_message',
        messageId,
        content: [{ type: 'text', text }],
      });
    });

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
              await notifyClient({
                sessionUpdate: 'agent_message_chunk',
                messageId: `msg_agent_soft_deny_${Date.now()}`,
                content: { type: 'text', text: '\n\n' + msg },
              });
            }
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
              if (u.sessionUpdate === 'state_update' && u.state === 'idle') {
                finish(u.stopReason || 'end_turn');
                return;
              }
              await notifyClient(u);
            }
          }
        });
      };

      const onError = (err: Error) => {
        console.error(`[ACP-SDK] onError (sid: ${sessionId}):`, err.message);
        queue.enqueue(async () => {
          await notifyClient({
            sessionUpdate: 'agent_message_chunk',
            messageId: `msg_agent_err_${Date.now()}`,
            content: { type: 'text', text: `\n[agy error] ${err.message}` },
          });
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
        const geminiBin = path.join(
          process.env.USERPROFILE || process.env.HOME || '',
          '.gemini',
          'bin',
          process.platform === 'win32' ? 'agy.exe' : 'agy',
        );
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
