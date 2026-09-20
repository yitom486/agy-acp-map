import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  normalizePromptBlocksSync,
  STAGING_DIRNAME,
} from './prompt-normalize.ts';

describe('normalizePromptBlocksSync', () => {
  test('requires cwd', () => {
    const r = normalizePromptBlocksSync([{ type: 'text', text: 'hi' }], { cwd: '' as never });
    expect(r.text).toBe('');
    expect(r.notes.length).toBeGreaterThan(0);
  });

  test('flattens text blocks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-norm-'));
    const r = normalizePromptBlocksSync(
      [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ],
      { cwd: dir },
    );
    expect(r.text).toContain('hello');
    expect(r.text).toContain('world');
  });

  test('stages image base64 to staging dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-norm-'));
    const png = path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png');
    const b64 = fs.readFileSync(png).toString('base64');
    const r = normalizePromptBlocksSync(
      [
        { type: 'text', text: 'what color?' },
        { type: 'image', mimeType: 'image/png', data: b64 },
      ],
      { cwd: dir },
    );
    expect(r.stagedFiles.length).toBe(1);
    expect(fs.existsSync(r.stagedFiles[0]!)).toBe(true);
    expect(r.text).toContain('image file at:');
    expect(r.stagedFiles[0]!).toContain(STAGING_DIRNAME);
  });

  test('resource text inlined', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-norm-'));
    const r = normalizePromptBlocksSync(
      [{ type: 'resource', resource: { uri: 'file:///a.txt', text: 'body' } }],
      { cwd: dir },
    );
    expect(r.text).toContain('body');
    expect(r.text).toContain('file:///a.txt');
  });
});
