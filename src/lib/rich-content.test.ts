import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
});

describe('fileToAcpImageBlock', () => {
  test('reads small png fixture', () => {
    const png = path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png');
    expect(fs.existsSync(png)).toBe(true);
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
});

describe('buildRichToolContent', () => {
  test('includes text + inlines existing image', () => {
    const png = path.join(import.meta.dir, '..', '..', 'fixtures', 'tiny.png');
    const { content, imagePaths, emittedImages } = buildRichToolContent(
      `saved to ${png}`,
      undefined,
      undefined,
      { toolName: 'generate_image' },
    );
    expect(imagePaths).toContain(png);
    expect(emittedImages).toBeGreaterThanOrEqual(1);
    expect(content.length).toBeGreaterThanOrEqual(2);
  });
});
