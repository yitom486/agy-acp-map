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
  SessionHistoryStore,
  resolveHistoryDir,
} from '../lib/session-history.ts';
import {
  type SdkSession,
  type ProtocolVersion,
  catalogChoices,
  AsyncSerialQueue,
} from './types.ts';
import { debugLog } from '../lib/debug-log.ts';

export interface SessionCoreOptions {
  sessionStore?: SessionStore | string;
  historyStore?: SessionHistoryStore | string;
}

/** Rows without any completed turn older than this are hidden from
 * session/list (still resumable/deletable by id — the store keeps them). */
export const EMPTY_SESSION_MAX_AGE_MS = 60 * 60 * 1000;

/** First user prompt collapsed to one line, capped for list display. */
export function deriveTitle(text: string, maxLen = 60): string {
  const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > maxLen ? flat.slice(0, maxLen) + '…' : flat;
}

export class AgySessionCore {
  readonly sessions = new Map<string, SdkSession>();
  readonly sessionStore: SessionStore;
  readonly historyStore: SessionHistoryStore;
  private catalogPromise: Promise<DiscoveryResult> | null = null;

  constructor(options?: SessionCoreOptions) {
    if (options?.sessionStore instanceof SessionStore) {
      this.sessionStore = options.sessionStore;
    } else if (typeof options?.sessionStore === 'string') {
      this.sessionStore = new SessionStore(options.sessionStore);
    } else {
      this.sessionStore = new SessionStore();
    }

    if (options?.historyStore instanceof SessionHistoryStore) {
      this.historyStore = options.historyStore;
    } else if (typeof options?.historyStore === 'string') {
      this.historyStore = new SessionHistoryStore(options.historyStore);
    } else {
      this.historyStore = new SessionHistoryStore(resolveHistoryDir(this.sessionStore.filePath));
    }
  }

  async getDiscovery(): Promise<DiscoveryResult> {
    if (!this.catalogPromise) {
      this.catalogPromise = discoverAgyCatalog();
    }
    return this.catalogPromise;
  }

  /** Warm-up toggle: AGY_ACP_WARMUP=0/false/no disables connect-time pre-spawn. */
  warmupEnabled(): boolean {
    const v = process.env.AGY_ACP_WARMUP;
    if (v === undefined || v === '') return true;
    const s = v.trim().toLowerCase();
    return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
  }

  /** Shared spawn-target builder so warm-up and promptTurn launch identical agy. */
  buildSpawnTarget(session: SdkSession): { bin: string; args: string[] } {
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
    const rawBin = process.env.AGY_BIN;
    let bin = rawBin && rawBin !== 'undefined' && rawBin !== 'null' ? rawBin : 'agy';
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
    return { bin: execBin, args: execArgs };
  }

  /**
   * Connect-time warm-up: pull agy up in the background right after
   * session/new|resume so the first prompt reuses a writable process.
   * Fire-and-forget — never blocks the new/resume response. First real
   * prompt attaches via setCallbacks; close/delete/cancel still kill.
   */
  warmupSession(sessionId: string): void {
    if (!this.warmupEnabled()) return;
    const session = this.sessions.get(sessionId);
    if (!session || session.deleted || session.busy) return;
    if (session.proc.isWritable()) return;
    const target = this.buildSpawnTarget(session);
    console.error(`[ACP-SDK] warmup: pre-spawning agy for sid: ${sessionId}`);
    void session.proc
      .spawn({
        bin: target.bin,
        args: target.args,
        cwd: session.cwd,
        onEvent: (event: any) => {
          if (session.deleted || !this.sessions.has(sessionId)) return;
          try {
            const { state } = mapAgyEvent(session.sessionId, event, session.mapper, {
              model: session.model,
            });
            session.mapper = state;
            if (state.conversationId && state.conversationId !== session.conversationId) {
              session.conversationId = state.conversationId;
              this.persistSession(session);
            }
          } catch {
            /* warm-up mapping must never throw */
          }
        },
        onError: (err: Error) => {
          console.error(`[ACP-SDK] warmup error (sid: ${sessionId}):`, err.message);
        },
        onStderr: (line: string) => {
          session.stderrBuf += line + '\n';
        },
        onExit: (code: number | null) => {
          console.error(`[ACP-SDK] warmup exit (sid: ${sessionId}): code: ${code}`);
        },
      })
      .catch((err: any) => {
        console.error(`[ACP-SDK] warmup spawn failed (sid: ${sessionId}):`, err?.message);
      });
  }

  /** Kill every live child (bridge shutdown path). Clients should still close/delete per session. */
  async shutdown(): Promise<void> {
    const kills: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      kills.push(session.proc.kill().catch(() => undefined));
    }
    await Promise.all(kills);
  }

  persistSession(session: SdkSession, opts?: { throwOnError?: boolean }): void {
    if (session.deleted || !this.sessions.has(session.sessionId)) {
      return;
    }
    try {
      this.sessionStore.upsert(sessionToRecord(session));
    } catch (err) {
      console.warn(`[ACP-STORE] Warning: failed to persist session ${session?.sessionId}:`, err);
      if (opts?.throwOnError) throw err;
    }
  }

  persistTurnHistory(
    sessionId: string,
    userText: string,
    assistantText: string,
    stopReason: string,
    eligible = true,
  ): void {
    try {
      this.historyStore.appendTurn(
        sessionId,
        userText,
        eligible && stopReason !== 'cancelled' ? assistantText : undefined,
      );
    } catch (err) {
      // History is a display cache. A write failure must never break the ACP turn.
      console.warn(`[ACP-HISTORY] Warning: failed to persist turn ${sessionId}:`, err);
    }
  }

  async replayHistory(
    sessionId: string,
    protocolVersion: ProtocolVersion,
    notifyClient: (update: any) => Promise<void> | void,
  ): Promise<void> {
    const records = this.historyStore.read(sessionId);
    for (const record of records) {
      if (protocolVersion === 1) {
        await notifyClient({
          sessionUpdate: record.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          messageId: record.messageId,
          content: { type: 'text', text: record.text },
        });
      } else {
        await notifyClient({
          sessionUpdate: record.role === 'user' ? 'user_message' : 'agent_message',
          messageId: record.messageId,
          content: [{ type: 'text', text: record.text }],
        });
      }
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
    debugLog(`createSession v${protocolVersion} cwd=${cwd}`);
    if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
      throw new RequestError(-32602, 'cwd must be an absolute path');
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new RequestError(-32602, `cwd does not exist or is not a directory: ${cwd}`);
    }

    if (params?.additionalDirectories !== undefined) {
      if (!Array.isArray(params.additionalDirectories)) {
        throw new RequestError(-32602, 'additionalDirectories must be an array');
      }
      for (const d of params.additionalDirectories) {
        if (typeof d !== 'string' || !path.isAbsolute(d)) {
          throw new RequestError(-32602, `additionalDirectory must be an absolute path: ${d}`);
        }
      }
    }
    if (params?.mcpServers !== undefined && !Array.isArray(params.mcpServers)) {
      throw new RequestError(-32602, 'mcpServers must be an array');
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
    // Connect-time warm-up: pull agy up now so first prompt doesn't pay cold spawn.
    this.warmupSession(sessionId);

    return {
      session,
      discovery,
      meta: this.sessionMeta(session),
    };
  }

  async resumeSession(
    params: any,
    protocolVersion: ProtocolVersion = 1,
    opts?: { warmup?: boolean },
  ): Promise<{ session: SdkSession; discovery: DiscoveryResult; meta?: Record<string, unknown> }> {
    const sessionId = params?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') {
      throw new RequestError(-32602, 'sessionId is required for session/resume');
    }

    const cwd = params?.cwd;
    if (!cwd || typeof cwd !== 'string') {
      throw new RequestError(-32602, 'cwd is required for session/resume');
    }
    if (!path.isAbsolute(cwd)) {
      throw new RequestError(-32602, 'cwd must be an absolute path');
    }
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new RequestError(-32602, `cwd does not exist or is not a directory: ${cwd}`);
    }

    if (params?.replayFrom !== undefined && params?.replayFrom !== null) {
      if (protocolVersion !== 2 || params.replayFrom?.type !== 'start') {
        throw new RequestError(
          -32602,
          protocolVersion === 2
            ? 'only replayFrom.type="start" is supported by this agent'
            : 'session/resume with replayFrom is only supported by ACP v2',
        );
      }
    }

    if (params?.mcpServers !== undefined) {
      if (!Array.isArray(params.mcpServers)) {
        throw new RequestError(-32602, 'mcpServers must be an array');
      }
      if (params.mcpServers.length > 0) {
        throw new RequestError(-32602, 'mcpServers are not supported by this agent');
      }
    }

    let additionalDirectories: string[] = [];
    if (params?.additionalDirectories !== undefined) {
      if (!Array.isArray(params.additionalDirectories)) {
        throw new RequestError(-32602, 'additionalDirectories must be an array');
      }
      for (const d of params.additionalDirectories) {
        if (typeof d !== 'string' || !path.isAbsolute(d)) {
          throw new RequestError(-32602, `additionalDirectory must be an absolute path: ${d}`);
        }
      }
      additionalDirectories = params.additionalDirectories;
    }

    let session = this.sessions.get(sessionId);
    if (!session) {
      const record = this.sessionStore.get(sessionId);
      if (!record) {
        throw new RequestError(-32001, `Session not found: ${sessionId}`);
      }

      // Legacy sessions created before v2 was introduced have no protocolVersion; strictly default them to v1
      const recordedVersion = record.protocolVersion ?? 1;
      if (recordedVersion !== protocolVersion) {
        throw new RequestError(
          -32602,
          `Session ${sessionId} was created with ACP v${recordedVersion} and cannot be resumed with v${protocolVersion}`,
        );
      }

      if (record.cwd && path.resolve(record.cwd) !== path.resolve(cwd)) {
        throw new RequestError(
          -32602,
          `cwd does not match session cwd: expected ${record.cwd}, got ${cwd}`,
        );
      }

      const richRoots = richRootsFromSession({
        cwd,
        additionalDirectories,
      });
      const mapper = createMapperState(richRoots);
      if (record.conversationId) {
        mapper.conversationId = record.conversationId;
      }

      session = {
        sessionId,
        cwd,
        additionalDirectories,
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

      if (path.resolve(session.cwd) !== path.resolve(cwd)) {
        throw new RequestError(
          -32602,
          `cwd does not match session cwd: expected ${session.cwd}, got ${cwd}`,
        );
      }

      session.additionalDirectories = additionalDirectories;
      session.updatedAt = new Date().toISOString();
    }

    const discovery = await this.getDiscovery();
    this.applyCatalogDefaults(session, discovery);
    this.persistSession(session);
    // Re-attached sessions also get a warm process if none is alive.
    // History-only loads (v1 session/load) skip this: no prompt follows yet.
    if (opts?.warmup !== false) {
      this.warmupSession(sessionId);
    }

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

  async listSessions(
    params?: any,
    opts?: { now?: number },
  ): Promise<{ sessions: any[]; nextCursor?: string | null }> {
    const filterCwd = params?.cwd;
    if (filterCwd !== undefined && filterCwd !== null) {
      if (typeof filterCwd !== 'string' || !path.isAbsolute(filterCwd)) {
        throw new RequestError(-32602, 'cwd must be an absolute path');
      }
    }
    const disk = this.sessionStore.list(filterCwd);
    const diskById = new Map(disk.map((r) => [r.sessionId, r]));

    const allSessions: any[] = [];
    for (const [id, s] of this.sessions.entries()) {
      if (filterCwd && s.cwd !== filterCwd) continue;
      allSessions.push({
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
      // Hide abandoned empties from the list view (no completed turn AND
      // older than the window). Rows stay on disk: resumable/deletable by
      // id. Live in-memory sessions are always listed (loop above).
      if (!r.conversationId) {
        const updated = r.updatedAt ? new Date(r.updatedAt).getTime() : NaN;
        const now = opts?.now ?? Date.now();
        if (Number.isFinite(updated) && now - updated > EMPTY_SESSION_MAX_AGE_MS) {
          continue;
        }
      }
      allSessions.push({
        sessionId: r.sessionId,
        cwd: r.cwd,
        title: r.title,
        updatedAt: r.updatedAt,
        ...(r.additionalDirectories?.length ? { additionalDirectories: r.additionalDirectories } : {}),
        ...(r.conversationId ? { conversationId: r.conversationId } : {}),
        _meta: r.model ? { model: r.model, conversationId: r.conversationId } : undefined,
      });
    }

    // Deterministic descending sort by updatedAt, then sessionId ascending
    allSessions.sort((a, b) => {
      const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (timeB !== timeA) return timeB - timeA;
      return a.sessionId.localeCompare(b.sessionId);
    });

    // Keyset pagination support per ACP v1/v2 schema with opaque cursor
    const cursor = params?.cursor;
    let startIndex = 0;
    if (cursor !== undefined && cursor !== null && cursor !== '') {
      if (typeof cursor !== 'string') {
        throw new RequestError(-32602, 'cursor must be a string');
      }
      try {
        const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed && typeof parsed.u === 'string' && typeof parsed.s === 'string') {
          const cursorTime = new Date(parsed.u).getTime();
          const cursorId = parsed.s;
          const foundIdx = allSessions.findIndex((s) => {
            const sTime = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
            if (sTime < cursorTime) return true;
            if (sTime === cursorTime && s.sessionId.localeCompare(cursorId) > 0) return true;
            return false;
          });
          startIndex = foundIdx >= 0 ? foundIdx : allSessions.length;
        } else if (
          typeof parsed?.offset === 'number' &&
          Number.isInteger(parsed.offset) &&
          parsed.offset >= 0
        ) {
          startIndex = parsed.offset;
        } else {
          throw new Error('invalid cursor structure');
        }
      } catch {
        throw new RequestError(-32602, `Invalid cursor token: ${cursor}`);
      }
    }

    const limit = 50;
    const paged = allSessions.slice(startIndex, startIndex + limit);
    const hasMore = startIndex + limit < allSessions.length;
    let nextCursor: string | undefined;
    if (hasMore && paged.length > 0) {
      const last = paged[paged.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ u: last.updatedAt, s: last.sessionId }),
      ).toString('base64url');
    }

    return nextCursor ? { sessions: paged, nextCursor } : { sessions: paged };
  }

  async deleteSession(params: any): Promise<{}> {
    const sessionId = params?.sessionId;
    if (!sessionId || typeof sessionId !== 'string') {
      throw new RequestError(-32602, 'sessionId must be a non-empty string');
    }

    const session = this.sessions.get(sessionId);
    if (session) {
      session.deleted = true;
      session.cancelled = true;
      this.sessions.delete(sessionId);
      try {
        await session.proc.kill();
      } catch {
        /* ignore */
      }
      cleanupSessionStaging(session.cwd, { sessionId, keep: false });
      session.stagedFiles = [];
    } else {
      const record = this.sessionStore.get(sessionId);
      if (record?.cwd) {
        cleanupSessionStaging(record.cwd, { sessionId, keep: false });
      }
    }

    this.sessionStore.delete(sessionId);
    this.historyStore.delete(sessionId);
    return {};
  }

  async closeSession(params: any): Promise<{}> {
    const sessionId = params?.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new RequestError(-32001, `unknown sessionId: ${sessionId}`);
    }

    await session.proc.kill();
    cleanupSessionStaging(session.cwd, { sessionId, keep: false });
    session.stagedFiles = [];
    this.sessions.delete(sessionId);

    if (deleteOnCloseEnabled()) {
      this.sessionStore.delete(sessionId);
      this.historyStore.delete(sessionId);
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
    protocolVersion: ProtocolVersion = 1,
    notifyClient: (update: any) => Promise<void>,
    opts?: { isPreLocked?: boolean },
  ): Promise<{ stopReason: string }> {
    const sessionId = params?.sessionId;
    if (!sessionId) {
      return Promise.reject(new RequestError(-32602, 'sessionId is required'));
    }
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
    if (session.busy && !opts?.isPreLocked) {
      return Promise.reject(new RequestError(-32002, 'session is busy; wait for idle or cancel'));
    }

    const { text, notes, stagedFiles } = normalizePromptBlocksSync(params?.prompt || [], {
      cwd: session.cwd,
      sessionId: session.sessionId,
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

    let visibleAssistantText = '';
    let historyTurnEligible = true;

    const captureVisibleAssistantText = (update: any) => {
      if (update?.sessionUpdate !== 'agent_message_chunk' && update?.sessionUpdate !== 'agent_message') {
        return;
      }
      const content = update.content;
      if (content?.type === 'text' && typeof content.text === 'string') {
        visibleAssistantText += content.text;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && typeof block.text === 'string') {
            visibleAssistantText += block.text;
          }
        }
      }
    };

    // v1 SessionUpdate has no `user_message` (only chunks) — echoing it breaks
    // strict v1 validation and looks stuck. v2 DOES support full `user_message`
    // and its tests/clients expect the echo, so keep it for v2 only.
    if (protocolVersion >= 2) {
      const messageId = `msg_user_${randomUUID().slice(0, 8)}`;
      queue.enqueue(async () => {
        try {
          await notifyClient({
            sessionUpdate: 'user_message',
            messageId,
            content: [{ type: 'text', text }],
          });
        } catch (err) {
          console.error(`[ACP-SDK] notify user_message failed (sid: ${sessionId}):`, (err as Error)?.message);
        }
      });
    }

    return new Promise<{ stopReason: string }>((resolve) => {
      let isSettled = false;

      const finish = (stopReason: string) => {
        if (!session.busy || isSettled) return;
        isSettled = true;
        session.busy = false;

        console.error(`[ACP-SDK] finish: ending turn for sid: ${sessionId} with stopReason: ${stopReason}`);

        queue.enqueue(async () => {
          if (session.deleted || !this.sessions.has(sessionId)) {
            resolve({ stopReason });
            return;
          }

          // Check if soft-deny happened and emit note
          if (!session.softDenyEmitted && session.softDenies.length) {
            session.softDenyEmitted = true;
            const msg = formatSoftDenyMessage(session.softDenies);
            if (msg) {
              visibleAssistantText += '\n\n' + msg;
              await notifyClient({
                sessionUpdate: 'agent_message_chunk',
                messageId: `msg_agent_soft_deny_${Date.now()}`,
                content: { type: 'text', text: '\n\n' + msg },
              });
            }
          }

          this.persistTurnHistory(
            sessionId,
            text,
            visibleAssistantText,
            stopReason,
            historyTurnEligible,
          );
          // First-turn title: feeds session/list display (id prefix otherwise).
          if (!session.title && text.trim()) {
            session.title = deriveTitle(text);
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
        if (session.deleted || !this.sessions.has(sessionId)) return;
        queue.enqueue(async () => {
          if (session.deleted || !this.sessions.has(sessionId)) return;
          const fromEvt = parseSoftDenyFromEvent(event);
          if (fromEvt.length) {
            session.softDenies = mergeSoftDenies(session.softDenies, fromEvt);
          }

          if (event?.event === 'result') {
            const status = String(event?.result?.status || '').toUpperCase();
            if (status && status !== 'SUCCESS' && status !== 'OK') {
              historyTurnEligible = false;
            }
          }

          const { notifications, state } = mapAgyEvent(session.sessionId, event, session.mapper, {
            model: session.model,
          });
          session.mapper = state;
          if (state.conversationId && state.conversationId !== session.conversationId) {
            session.conversationId = state.conversationId;
            this.persistSession(session);
          }

          for (const n of notifications) {
            const u = n.params?.update as any;
            if (!u) continue;
            captureVisibleAssistantText(u);
            if (u.sessionUpdate === 'state_update' && u.state === 'idle') {
              // Forward idle before finishing so strict v2 clients never hang in running.
              try {
                await notifyClient(u);
              } catch (err) {
                console.error(`[ACP-SDK] notify idle failed (sid: ${sessionId}):`, (err as Error)?.message);
              }
              finish(u.stopReason || 'end_turn');
              return;
            }
            try {
              await notifyClient(u);
            } catch (err) {
              // Per-notification isolation: one slow/failing notify must not
              // drop the rest of the batch and look like a stuck turn.
              console.error(`[ACP-SDK] notify ${u.sessionUpdate} failed (sid: ${sessionId}):`, (err as Error)?.message);
            }
          }
        });
      };

      const onError = (err: Error) => {
        console.error(`[ACP-SDK] onError (sid: ${sessionId}):`, err.message);
        historyTurnEligible = false;
        queue.enqueue(async () => {
          if (session.deleted || !this.sessions.has(sessionId)) return;
          await notifyClient({
            sessionUpdate: 'agent_message_chunk',
            messageId: `msg_agent_err_${Date.now()}`,
            content: { type: 'text', text: `\n[agy error] ${err.message}` },
          });
          finish('end_turn');
        });
      };

      const onStderr = (line: string) => {
        if (session.deleted || !this.sessions.has(sessionId)) return;
        session.stderrBuf += line + '\n';
        const parsed = parseSoftDeny(line);
        if (parsed.length) {
          session.softDenies = mergeSoftDenies(session.softDenies, parsed);
        }
      };

      const onExit = (code: number | null) => {
        console.error(`[ACP-SDK] onExit (sid: ${sessionId}): code: ${code}`);
        if (session.deleted || !this.sessions.has(sessionId)) return;
        if (session.busy && !isSettled) {
          finish(session.cancelled ? 'cancelled' : 'end_turn');
        }
      };

      const safety = resolveSafety(session);
      // Auto-pass contract: default autonomous must carry --dangerously-skip-permissions
      // so agy never opens an interactive/native permission prompt mid-turn.
      // Windows UAC popups come from the elevated command itself, never from this
      // bridge (spawn uses windowsHide + piped stdio, no shell/runas) — keep
      // --sandbox on to contain terminal side-effects.
      console.error(
        `[ACP-SDK] safety: sid: ${sessionId} safety=${safety.safety} skip=${safety.skipPermissions ? 1 : 0} sandbox=${safety.sandbox ? 1 : 0} warmed=${session.proc.isWritable() ? 1 : 0}`,
      );

      const target = this.buildSpawnTarget(session);
      const execBin = target.bin;
      const execArgs = target.args;

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
