import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SessionStore,
  resolveSessionStorePath,
  sessionToRecord,
  recordLaunchFields,
  deleteOnCloseEnabled,
  type SessionRecord,
} from './session-store.ts';

function tmpStoreFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-store-'));
  return path.join(dir, 'sessions.json');
}

function sample(partial: Partial<SessionRecord> & { sessionId: string; cwd: string }): SessionRecord {
  const now = '2026-09-20T09:00:00.000Z';
  return {
    createdAt: now,
    updatedAt: now,
    ...partial,
  };
}

describe('resolveSessionStorePath', () => {
  test('default under home/.agy-acp-map/sessions.json', () => {
    const p = resolveSessionStorePath({}, () => '/home/testuser');
    expect(p).toBe(path.join('/home/testuser', '.agy-acp-map', 'sessions.json'));
  });

  test('AGY_ACP_SESSION_STORE wins over AGY_ACP_STORE', () => {
    const p = resolveSessionStorePath(
      {
        AGY_ACP_STORE: '/tmp/a.json',
        AGY_ACP_SESSION_STORE: '/tmp/b.json',
      },
      () => '/home/x',
    );
    expect(p).toBe(path.resolve('/tmp/b.json'));
  });

  test('AGY_ACP_STORE used when SESSION_STORE unset', () => {
    const p = resolveSessionStorePath({ AGY_ACP_STORE: '/var/store.json' }, () => '/home/x');
    expect(p).toBe(path.resolve('/var/store.json'));
  });
});

describe('deleteOnCloseEnabled', () => {
  test('true for 1 or true', () => {
    expect(deleteOnCloseEnabled({ AGY_ACP_DELETE_ON_CLOSE: '1' })).toBe(true);
    expect(deleteOnCloseEnabled({ AGY_ACP_DELETE_ON_CLOSE: 'true' })).toBe(true);
  });
  test('false by default', () => {
    expect(deleteOnCloseEnabled({})).toBe(false);
    expect(deleteOnCloseEnabled({ AGY_ACP_DELETE_ON_CLOSE: '0' })).toBe(false);
  });
});

describe('SessionStore CRUD + atomic write', () => {
  let filePath: string;
  let store: SessionStore;
  let dir: string;

  beforeEach(() => {
    filePath = tmpStoreFile();
    dir = path.dirname(filePath);
    store = new SessionStore(filePath);
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('load missing file returns []', () => {
    expect(store.load()).toEqual([]);
  });

  test('upsert + get + list + delete', () => {
    const a = sample({
      sessionId: 's1',
      cwd: '/tmp/a',
      title: 'hello',
      conversationId: 'conv-1',
      model: 'flash',
      safety: 'safe',
    });
    store.upsert(a);
    expect(store.get('s1')).toEqual(a);
    expect(store.list()).toHaveLength(1);
    expect(store.list({ cwd: '/tmp/a' })).toHaveLength(1);
    expect(store.list({ cwd: '/other' })).toHaveLength(0);

    store.upsert({
      ...a,
      title: 'updated',
      updatedAt: '2026-09-20T10:00:00.000Z',
      conversationId: 'conv-2',
    });
    expect(store.get('s1')?.title).toBe('updated');
    expect(store.get('s1')?.conversationId).toBe('conv-2');
    expect(store.list()).toHaveLength(1);

    const b = sample({ sessionId: 's2', cwd: '/tmp/b' });
    store.upsert(b);
    expect(store.list()).toHaveLength(2);

    expect(store.delete('s1')).toBe(true);
    expect(store.get('s1')).toBeUndefined();
    expect(store.remove('s2')).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.delete('missing')).toBe(false);
  });

  test('save writes versioned JSON atomically (no leftover tmp)', () => {
    store.upsert(sample({ sessionId: 'x', cwd: '/c' }));
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.sessions).toHaveLength(1);
    const leftovers = fs.readdirSync(dir).filter((n) => n.includes('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('corrupt / empty file loads as []', () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, '{not json', 'utf8');
    expect(store.load()).toEqual([]);
    fs.writeFileSync(filePath, '', 'utf8');
    expect(store.load()).toEqual([]);
  });

  test('accepts legacy bare array file', () => {
    fs.mkdirSync(dir, { recursive: true });
    const legacy = [sample({ sessionId: 'leg', cwd: '/leg' })];
    fs.writeFileSync(filePath, JSON.stringify(legacy), 'utf8');
    expect(store.get('leg')?.cwd).toBe('/leg');
  });
});

describe('sessionToRecord / recordLaunchFields (resume rehydrate seed)', () => {
  test('round-trip launch snapshot without inventing transcript', () => {
    const session = {
      sessionId: 'sid-9',
      cwd: '/work',
      createdAt: '2026-09-20T01:00:00.000Z',
      updatedAt: '2026-09-20T02:00:00.000Z',
      title: 'first prompt…',
      conversationId: 'agy-conv-99',
      additionalDirectories: ['/extra'],
      model: 'gemini-flash',
      effort: 'low',
      mode: 'accept-edits' as const,
      agent: 'default',
      safety: 'autonomous' as const,
      sandbox: true,
      jsonSchema: '{"type":"object"}',
      printTimeout: '0',
      disableSlashCommands: true,
    };
    const rec = sessionToRecord(session);
    expect(rec.conversationId).toBe('agy-conv-99');
    expect(rec.model).toBe('gemini-flash');
    // No transcript / messages field on record
    expect('messages' in rec).toBe(false);
    expect('history' in rec).toBe(false);

    const seed = recordLaunchFields(rec);
    expect(seed.sessionId).toBe('sid-9');
    expect(seed.conversationId).toBe('agy-conv-99');
    expect(seed.model).toBe('gemini-flash');
    expect(seed.safety).toBe('autonomous');
    expect(seed.sandbox).toBe(true);
    expect(seed.additionalDirectories).toEqual(['/extra']);
  });

  test('resume-from-store path: upsert → get → launch fields (no history replay data)', () => {
    const filePath = tmpStoreFile();
    const dir = path.dirname(filePath);
    try {
      const store = new SessionStore(filePath);
      const rec = sample({
        sessionId: 'closed-sid',
        cwd: '/proj',
        conversationId: 'c-resume',
        title: 'prior',
        model: 'flash',
        safety: 'safe',
        disableSlashCommands: true,
      });
      store.upsert(rec);

      // Simulate process restart: new store instance, empty memory
      const store2 = new SessionStore(filePath);
      const loaded = store2.get('closed-sid');
      expect(loaded).toBeTruthy();
      const seed = recordLaunchFields(loaded!);
      // Client would call session/resume → rehydrate memory from seed;
      // next prompt uses buildAgyArgs with --conversation. No session/update history.
      expect(seed.conversationId).toBe('c-resume');
      expect(JSON.stringify(seed)).not.toContain('session/update');
      expect(JSON.stringify(seed)).not.toContain('history');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
