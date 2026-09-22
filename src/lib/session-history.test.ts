import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionHistoryStore, resolveHistoryDir } from './session-history.ts';

describe('SessionHistoryStore', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-history-test-'));

  afterAll(() => {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      /* ignore test cleanup failures */
    }
  });

  test('writes only user and final assistant text as JSONL', () => {
    const store = new SessionHistoryStore(directory);
    store.appendTurn('session-1', 'Read the project', 'The project is healthy.');

    const file = store.filePath('session-1');
    const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.startsWith('{') && line.endsWith('}'))).toBe(true);

    const records = store.read('session-1');
    expect(records.map((record) => record.role)).toEqual(['user', 'assistant']);
    expect(records.map((record) => record.text)).toEqual([
      'Read the project',
      'The project is healthy.',
    ]);
  });

  test('omits an empty assistant answer and tolerates a corrupt trailing line', () => {
    const store = new SessionHistoryStore(directory);
    store.appendTurn('session-2', 'A cancelled prompt', '');
    fs.appendFileSync(store.filePath('session-2'), '{incomplete', 'utf8');

    const records = store.read('session-2');
    expect(records).toHaveLength(1);
    expect(records[0].role).toBe('user');
  });

  test('marks interrupted turns partial, keeps success turns unmarked', () => {
    const store = new SessionHistoryStore(directory);
    store.appendTurn('session-p1', 'Stopped question', 'Half an an', { partial: true });
    store.appendTurn('session-p2', 'Full question', 'Complete answer.');

    const partial = store.read('session-p1');
    expect(partial.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(partial[1].text).toBe('Half an an');
    expect(partial[1].partial).toBe(true);

    const full = store.read('session-p2');
    expect(full[1].partial).toBeUndefined();
  });

  test('deletes one session file without affecting another session', () => {
    const store = new SessionHistoryStore(directory);
    store.appendTurn('session-3', 'Keep this', 'Kept');
    store.appendTurn('session-4', 'Delete this', 'Deleted');

    store.delete('session-4');

    expect(fs.existsSync(store.filePath('session-4'))).toBe(false);
    expect(store.read('session-3')).toHaveLength(2);
  });

  test('derives history beside the configured session store', () => {
    expect(resolveHistoryDir('D:/tmp/agy-acp/sessions.json')).toBe(
      path.resolve('D:/tmp/agy-acp/history'),
    );
  });
});
