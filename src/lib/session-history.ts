import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Small, display-oriented history journal.
 *
 * This is intentionally not a copy of agy's internal conversation database. It
 * only stores the text that an ACP client can display: user prompts and final
 * assistant text. Tool calls, tool output, thoughts, and internal events are
 * deliberately excluded.
 *
 * Display/persist parity: whatever text the client actually saw must be
 * reloadable. Interrupted turns (cancelled / failed) still persist their
 * partial text, marked with `partial: true`, so `session/load` replay shows
 * exactly what was on screen instead of dropping the turn entirely.
 */
export type SessionHistoryRole = 'user' | 'assistant';

export type SessionHistoryRecord = {
  version: 1;
  sessionId: string;
  messageId: string;
  role: SessionHistoryRole;
  text: string;
  createdAt: string;
  /**
   * True when the turn did not complete (cancelled / failed) and `text` is
   * only the partial output the client saw. Replay ignores the flag and
   * returns the text; readers must tolerate its absence (old journals).
   */
  partial?: boolean;
};

export function resolveHistoryDir(
  sessionStorePath?: string,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => os.homedir(),
): string {
  const configured = (env.AGY_ACP_HISTORY_DIR || '').trim();
  if (configured) return path.resolve(configured);

  if (sessionStorePath) {
    return path.join(path.dirname(path.resolve(sessionStorePath)), 'history');
  }

  return path.join(homedir(), '.agy-acp-map', 'history');
}

function historyFileName(sessionId: string): string {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required for history');
  }

  // ACP session IDs are opaque. Encoding the filename prevents path traversal
  // while leaving UUID-style IDs readable as filenames.
  return `${encodeURIComponent(sessionId)}.jsonl`;
}

function isRecord(value: unknown): value is SessionHistoryRecord {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    item.version === 1 &&
    typeof item.sessionId === 'string' &&
    typeof item.messageId === 'string' &&
    (item.role === 'user' || item.role === 'assistant') &&
    typeof item.text === 'string' &&
    typeof item.createdAt === 'string'
  );
}

export class SessionHistoryStore {
  readonly directory: string;

  constructor(directory?: string) {
    this.directory = path.resolve(directory || resolveHistoryDir());
  }

  filePath(sessionId: string): string {
    return path.join(this.directory, historyFileName(sessionId));
  }

  /**
   * Append one completed (or interrupted) turn as JSONL records.
   *
   * The assistant record is written whenever the turn produced visible text —
   * including cancelled/failed turns (`partial: true`). Only a truly empty
   * assistant answer is omitted, so cancelled/error-only turns never become
   * fake answers, while partial output stays reloadable.
   */
  appendTurn(
    sessionId: string,
    userText: string,
    assistantText?: string,
    opts?: { partial?: boolean },
  ): void {
    const records: SessionHistoryRecord[] = [];
    const now = new Date().toISOString();

    if (userText) {
      records.push({
        version: 1,
        sessionId,
        messageId: `history_user_${randomUUID()}`,
        role: 'user',
        text: userText,
        createdAt: now,
      });
    }

    if (assistantText && assistantText.trim()) {
      records.push({
        version: 1,
        sessionId,
        messageId: `history_agent_${randomUUID()}`,
        role: 'assistant',
        text: assistantText,
        createdAt: new Date().toISOString(),
        ...(opts?.partial ? { partial: true } : {}),
      });
    }

    if (!records.length) return;

    fs.mkdirSync(this.directory, { recursive: true });
    const payload = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
    fs.appendFileSync(this.filePath(sessionId), payload, 'utf8');
  }

  /** Read valid records and ignore incomplete/corrupt trailing lines. */
  read(sessionId: string): SessionHistoryRecord[] {
    return this.readUpTo(sessionId, Infinity);
  }

  /**
   * First user prompt text for backfilling list titles. Stops at the first
   * valid user record instead of parsing the whole journal.
   */
  firstUserText(sessionId: string): string | null {
    const records = this.readUpTo(sessionId, 50);
    const first = records.find((r) => r.role === 'user' && r.text.trim());
    return first ? first.text : null;
  }

  private readUpTo(sessionId: string, maxLines: number): SessionHistoryRecord[] {
    const file = this.filePath(sessionId);
    if (!fs.existsSync(file)) return [];

    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }

    const records: SessionHistoryRecord[] = [];
    let lines = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (++lines > maxLines) break;
      try {
        const parsed = JSON.parse(line);
        if (isRecord(parsed) && parsed.sessionId === sessionId) {
          records.push(parsed);
        }
      } catch {
        // A partially written final line must not make the whole history unusable.
      }
    }
    return records;
  }

  delete(sessionId: string): void {
    const file = this.filePath(sessionId);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (err) {
      console.warn(`[ACP-HISTORY] Warning: failed to delete ${file}:`, err);
    }
  }
}
