/**
 * Lightweight on-disk session index for ACP sessionId ↔ agy conversationId mapping.
 * Does NOT store transcripts — Client / zustand owns history.
 *
 * Default path: ~/.agy-acp-map/sessions.json
 * Override: AGY_ACP_STORE or AGY_ACP_SESSION_STORE
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Launch-config snapshot persisted for resume-after-close/restart. */
export type SessionRecord = {
  sessionId: string;
  conversationId?: string;
  title?: string;
  cwd: string;
  additionalDirectories?: string[];
  model?: string;
  effort?: string;
  mode?: string;
  agent?: string;
  safety?: 'safe' | 'autonomous' | 'autonomous-unsandboxed';
  sandbox?: boolean;
  jsonSchema?: string;
  printTimeout?: string;
  disableSlashCommands?: boolean;
  protocolVersion?: 1 | 2;
  createdAt: string;
  updatedAt: string;
};

export type SessionStoreFile = {
  version: 1;
  sessions: SessionRecord[];
};

/** Resolve store file path from env or default under home. */
export function resolveSessionStorePath(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => os.homedir(),
): string {
  const fromEnv =
    (env.AGY_ACP_SESSION_STORE || env.AGY_ACP_STORE || '').trim() || undefined;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(homedir(), '.agy-acp-map', 'sessions.json');
}

export function deleteOnCloseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGY_ACP_DELETE_ON_CLOSE === '1' || env.AGY_ACP_DELETE_ON_CLOSE === 'true';
}

/** Build a store record from a live Session-like object. */
export function sessionToRecord(session: {
  sessionId: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title?: string;
  conversationId?: string;
  additionalDirectories?: string[];
  model?: string;
  effort?: string;
  mode?: string;
  agent?: string;
  safety?: SessionRecord['safety'];
  sandbox?: boolean;
  jsonSchema?: string;
  printTimeout?: string;
  disableSlashCommands?: boolean;
  protocolVersion?: 1 | 2;
}): SessionRecord {
  const rec: SessionRecord = {
    sessionId: session.sessionId,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  if (session.protocolVersion !== undefined) rec.protocolVersion = session.protocolVersion;
  if (session.conversationId) rec.conversationId = session.conversationId;
  if (session.title !== undefined) rec.title = session.title;
  if (session.additionalDirectories?.length) {
    rec.additionalDirectories = [...session.additionalDirectories];
  }
  if (session.model !== undefined) rec.model = session.model;
  if (session.effort !== undefined) rec.effort = session.effort;
  if (session.mode !== undefined) rec.mode = session.mode;
  if (session.agent !== undefined) rec.agent = session.agent;
  if (session.safety !== undefined) rec.safety = session.safety;
  if (session.sandbox !== undefined) rec.sandbox = session.sandbox;
  if (session.jsonSchema !== undefined) rec.jsonSchema = session.jsonSchema;
  if (session.printTimeout !== undefined) rec.printTimeout = session.printTimeout;
  if (session.disableSlashCommands !== undefined) {
    rec.disableSlashCommands = session.disableSlashCommands;
  }
  return rec;
}

/**
 * Fields needed to rehydrate an in-memory Session (no child process yet).
 * Caller attaches proc/mapper/runtime state.
 */
export function recordLaunchFields(record: SessionRecord): {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  createdAt: string;
  updatedAt: string;
  title?: string;
  conversationId?: string;
  model?: string;
  effort?: string;
  mode?: string;
  agent?: string;
  safety?: SessionRecord['safety'];
  sandbox?: boolean;
  jsonSchema?: string;
  printTimeout?: string;
  disableSlashCommands?: boolean;
  protocolVersion?: 1 | 2;
} {
  return {
    sessionId: record.sessionId,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.protocolVersion !== undefined ? { protocolVersion: record.protocolVersion } : {}),
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.conversationId ? { conversationId: record.conversationId } : {}),
    ...(record.additionalDirectories?.length
      ? { additionalDirectories: [...record.additionalDirectories] }
      : {}),
    ...(record.model !== undefined ? { model: record.model } : {}),
    ...(record.effort !== undefined ? { effort: record.effort } : {}),
    ...(record.mode !== undefined ? { mode: record.mode } : {}),
    ...(record.agent !== undefined ? { agent: record.agent } : {}),
    ...(record.safety !== undefined ? { safety: record.safety } : {}),
    ...(record.sandbox !== undefined ? { sandbox: record.sandbox } : {}),
    ...(record.jsonSchema !== undefined ? { jsonSchema: record.jsonSchema } : {}),
    ...(record.printTimeout !== undefined ? { printTimeout: record.printTimeout } : {}),
    ...(record.disableSlashCommands !== undefined
      ? { disableSlashCommands: record.disableSlashCommands }
      : {}),
  };
}

export class SessionStore {
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || resolveSessionStorePath();
  }

  /** Read all records; missing/corrupt file → []. */
  load(): SessionRecord[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw) as SessionStoreFile | SessionRecord[];
      if (Array.isArray(parsed)) {
        return parsed.filter(isSessionRecord);
      }
      if (parsed && Array.isArray(parsed.sessions)) {
        return parsed.sessions.filter(isSessionRecord);
      }
      return [];
    } catch {
      return [];
    }
  }

  /** Atomic write: temp file in same dir + rename. */
  save(records: SessionRecord[]): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload: SessionStoreFile = { version: 1, sessions: records };
    const tmp = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    const data = JSON.stringify(payload, null, 2) + '\n';
    fs.writeFileSync(tmp, data, 'utf8');
    try {
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // Windows: rename over existing may fail — unlink then rename
      try {
        if (fs.existsSync(this.filePath)) fs.unlinkSync(this.filePath);
        fs.renameSync(tmp, this.filePath);
      } catch (err2) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
        throw err2 ?? err;
      }
    }
  }

  upsert(record: SessionRecord): void {
    if (!record?.sessionId || !record.cwd) {
      throw new Error('SessionRecord requires sessionId and cwd');
    }
    const list = this.load();
    const idx = list.findIndex((r) => r.sessionId === record.sessionId);
    if (idx >= 0) {
      list[idx] = { ...list[idx], ...record, sessionId: record.sessionId };
    } else {
      list.push(record);
    }
    this.save(list);
  }

  get(sessionId: string): SessionRecord | undefined {
    if (!sessionId) return undefined;
    return this.load().find((r) => r.sessionId === sessionId);
  }

  list(filter?: { cwd?: string }): SessionRecord[] {
    let list = this.load();
    if (filter?.cwd) list = list.filter((r) => r.cwd === filter.cwd);
    return list;
  }

  delete(sessionId: string): boolean {
    return this.remove(sessionId);
  }

  remove(sessionId: string): boolean {
    if (!sessionId) return false;
    const list = this.load();
    const next = list.filter((r) => r.sessionId !== sessionId);
    if (next.length === list.length) return false;
    this.save(next);
    return true;
  }
}

function isSessionRecord(r: unknown): r is SessionRecord {
  if (!r || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  return typeof o.sessionId === 'string' && typeof o.cwd === 'string';
}
