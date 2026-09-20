import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  normalizePromptBlocksSync,
  STAGING_DIRNAME,
  cleanupStaging,
  cleanupSessionStaging,
  DEFAULT_MAX_BLOB_BYTES,
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

  test('rejects oversized single blob', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-norm-'));
    // ~100KB of zeros as base64 — set maxBlob tiny
    const buf = Buffer.alloc(64 * 1024, 1);
    const b64 = buf.toString('base64');
    const r = normalizePromptBlocksSync(
      [{ type: 'image', mimeType: 'image/png', data: b64 }],
      { cwd: dir, maxBlobBytes: 1024 },
    );
    expect(r.sizeRejected).toBe(true);
    expect(r.stagedFiles.length).toBe(0);
    expect(r.notes.some((n) => /max single size/i.test(n))).toBe(true);
  });

  test('rejects when total exceeds maxTotalBytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-norm-'));
    const buf = Buffer.alloc(2000, 2);
    const b64 = buf.toString('base64');
    const r = normalizePromptBlocksSync(
      [
        { type: 'image', mimeType: 'image/png', data: b64 },
        { type: 'image', mimeType: 'image/png', data: b64 },
      ],
      { cwd: dir, maxBlobBytes: 5000, maxTotalBytes: 2500 },
    );
    expect(r.sizeRejected).toBe(true);
    // first may succeed, second rejected
    expect(r.stagedFiles.length).toBeLessThan(2);
    expect(DEFAULT_MAX_BLOB_BYTES).toBe(8 * 1024 * 1024);
  });
});

describe('cleanupStaging', () => {
  test('removes staged files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-clean-'));
    const staging = path.join(dir, STAGING_DIRNAME);
    fs.mkdirSync(staging);
    const f = path.join(staging, 'x.bin');
    fs.writeFileSync(f, 'hi');
    const { removed, skipped } = cleanupStaging([f]);
    expect(skipped).toBe(false);
    expect(removed).toContain(f);
    expect(fs.existsSync(f)).toBe(false);
  });

  test('cleanupSessionStaging empties dir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-clean2-'));
    const staging = path.join(dir, STAGING_DIRNAME);
    fs.mkdirSync(staging);
    fs.writeFileSync(path.join(staging, 'a.bin'), 'a');
    fs.writeFileSync(path.join(staging, 'b.bin'), 'b');
    const { removed } = cleanupSessionStaging(dir);
    expect(removed.length).toBe(2);
  });

  test('AGY_ACP_KEEP_STAGING skips cleanup', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-keep-'));
    const f = path.join(dir, 'keep.bin');
    fs.writeFileSync(f, 'x');
    const prev = process.env.AGY_ACP_KEEP_STAGING;
    process.env.AGY_ACP_KEEP_STAGING = '1';
    try {
      const { skipped, removed } = cleanupStaging([f]);
      expect(skipped).toBe(true);
      expect(removed.length).toBe(0);
      expect(fs.existsSync(f)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AGY_ACP_KEEP_STAGING;
      else process.env.AGY_ACP_KEEP_STAGING = prev;
    }
  });
});
