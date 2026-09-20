import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isPathAllowed, resolveAgainstCwd, decodeFsPath } from './path-allowlist.ts';
import { fileToAcpImageBlock } from './rich-content.ts';

describe('path allowlist', () => {
  test('allows files under cwd', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-allow-'));
    const png = path.join(dir, 'a.png');
    fs.copyFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png'), png);
    expect(isPathAllowed(png, { cwd: dir })).toBe(true);
    expect(isPathAllowed(png, { cwd: dir, stagingDir: path.join(dir, '.agy-acp-staging') })).toBe(
      true,
    );
  });

  test('denies files outside roots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-allow-'));
    const outside = path.join(os.tmpdir(), `agy-outside-${Date.now()}.png`);
    fs.copyFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png'), outside);
    expect(isPathAllowed(outside, { cwd: dir })).toBe(false);
    // fileToAcpImageBlock with cwd must also deny
    expect(fileToAcpImageBlock(outside, { cwd: dir })).toBeNull();
    fs.unlinkSync(outside);
  });

  test('allows under additionalDirectories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-allow-'));
    const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-extra-'));
    const png = path.join(extra, 'x.png');
    fs.copyFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png'), png);
    expect(isPathAllowed(png, { cwd: dir })).toBe(false);
    expect(isPathAllowed(png, { cwd: dir, additionalDirectories: [extra] })).toBe(true);
    const block = fileToAcpImageBlock(png, { cwd: dir, additionalDirectories: [extra] });
    expect(block).not.toBeNull();
    expect(block!.type).toBe('image');
  });

  test('relative paths resolve against session cwd not process.cwd()', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rel-'));
    const png = path.join(dir, 'rel.png');
    fs.copyFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png'), png);
    const resolved = resolveAgainstCwd('rel.png', dir);
    expect(resolved).toBeTruthy();
    expect(fs.realpathSync(resolved!)).toBe(fs.realpathSync(png));
    const block = fileToAcpImageBlock('rel.png', { cwd: dir });
    expect(block).not.toBeNull();
  });

  test('allows under stagingDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-stg-'));
    const staging = path.join(dir, '.agy-acp-staging');
    fs.mkdirSync(staging);
    const png = path.join(staging, 's.png');
    fs.copyFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png'), png);
    expect(isPathAllowed(png, { cwd: dir, stagingDir: staging })).toBe(true);
  });

  test('decodeFsPath handles file URI', () => {
    const s = decodeFsPath('file:///tmp/foo.png');
    expect(s).toContain('tmp');
    expect(s).toContain('foo.png');
  });
});
