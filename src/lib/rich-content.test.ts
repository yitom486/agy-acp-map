import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  extractImagePaths,
  fileToAcpImageBlock,
  buildRichToolContent,
} from './rich-content.ts';

describe('extractImagePaths', () => {
  test('finds absolute and markdown paths', () => {
    const text = 'see /tmp/foo.png and [img](./bar.jpg) plus file:///home/x/a.webp';
    const paths = extractImagePaths(text);
    expect(paths.some((p) => p.includes('foo.png'))).toBe(true);
    expect(paths.some((p) => p.includes('bar.jpg'))).toBe(true);
  });

  test('walks objects with path-ish keys', () => {
    const paths = extractImagePaths({ image_path: '/var/out/x.png', nested: { file: '/a/b.gif' } });
    expect(paths).toContain('/var/out/x.png');
    expect(paths).toContain('/a/b.gif');
  });

  test('finds Windows drive and UNC paths embedded in prose', () => {
    const drive = String.raw`C:\Users\demo\Pictures\render 01.png`;
    const unc = String.raw`\\server\share\render.jpg`;
    const paths = extractImagePaths(`saved to ${drive}; backup at ${unc}.`);
    expect(paths).toContain(drive);
    expect(paths).toContain(unc);
  });
});

describe('fileToAcpImageBlock', () => {
  test('reads small png fixture', () => {
    const png = path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png');
    expect(fs.existsSync(png)).toBe(true);
    // No cwd → allowlist not enforced (offline/unit convenience)
    const block = fileToAcpImageBlock(png);
    expect(block).not.toBeNull();
    expect(block!.type).toBe('image');
    expect(block!.mimeType).toBe('image/png');
    expect(block!.data.length).toBeGreaterThan(10);
  });

  test('skips missing / oversized', () => {
    expect(fileToAcpImageBlock('/no/such/file.png')).toBeNull();
    const tmp = path.join(os.tmpdir(), `big-${Date.now()}.png`);
    fs.writeFileSync(tmp, Buffer.alloc(3 * 1024 * 1024));
    expect(fileToAcpImageBlock(tmp)).toBeNull();
    fs.unlinkSync(tmp);
  });

  test('reads file URI and returns a standard file URI', () => {
    const png = path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png');
    const uri = pathToFileURL(png).href;
    const block = fileToAcpImageBlock(uri);
    expect(block).not.toBeNull();
    expect(block!.uri).toBe(uri);
  });

  test('with cwd allowlist: allow under root, deny outside', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rich-'));
    const inside = path.join(dir, 'in.png');
    fs.copyFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png'), inside);
    expect(fileToAcpImageBlock(inside, { cwd: dir })).not.toBeNull();

    const outside = path.join(os.tmpdir(), `agy-rich-out-${Date.now()}.png`);
    fs.copyFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png'), outside);
    expect(fileToAcpImageBlock(outside, { cwd: dir })).toBeNull();
    fs.unlinkSync(outside);
  });
});

describe('buildRichToolContent', () => {
  test('includes text + inlines existing image', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-rich2-'));
    const png = path.join(dir, 'out.png');
    fs.copyFileSync(path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png'), png);
    const { content, imagePaths, emittedImages } = buildRichToolContent(
      `saved to ${png}`,
      undefined,
      undefined,
      { toolName: 'generate_image', cwd: dir },
    );
    expect(imagePaths).toContain(png);
    expect(emittedImages).toBeGreaterThanOrEqual(1);
    expect(content.length).toBeGreaterThanOrEqual(2);
  });
});
