import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveLargeToolOutput } from './large-tool-output.ts';

describe('large tool output', () => {
  test('restores only this conversation generated output, bounded and without following escape links', () => {
    const root = fs.mkdtempSync(path.join(import.meta.dir, '../../scratch-output-'));
    try {
      const file = path.join(root, 'conversation-1/.system_generated/steps/8/output.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const envelope = JSON.stringify({ schemaVersion: 1, id: 'test', kind: 'html-artifact', title: 'diagram', html: '<svg></svg>' });
      fs.writeFileSync(file, envelope);
      const pointer = 'The output was large and was saved to: ' + pathToFileURL(file).href;
      expect(resolveLargeToolOutput(pointer, 'conversation-1', root)).toBe(envelope);
      expect(resolveLargeToolOutput(pointer, 'other-conversation', root)).toBe(pointer);
      expect(resolveLargeToolOutput(pointer, undefined, root)).toBe(pointer);
      expect(resolveLargeToolOutput(envelope, 'conversation-1', root)).toBe(envelope);
      fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
      expect(resolveLargeToolOutput(pointer, 'conversation-1', root)).toBe(pointer);
      fs.unlinkSync(file);
      expect(resolveLargeToolOutput(pointer, 'conversation-1', root)).toBe(pointer);
      const outside = path.join(root, 'secret.txt');
      fs.writeFileSync(outside, 'not tool output');
      const outsidePointer = 'The output was large and was saved to: ' + pathToFileURL(outside).href;
      expect(resolveLargeToolOutput(outsidePointer, 'conversation-1', root)).toBe(outsidePointer);
      // Junction works on Windows without symbolic-link privileges.
      const target = path.join(root, 'outside');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'output.txt'), 'not tool output');
      fs.rmSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(target, path.dirname(file), process.platform === 'win32' ? 'junction' : 'dir');
      expect(resolveLargeToolOutput(pointer, 'conversation-1', root)).toBe(pointer);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
