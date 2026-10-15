import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Restore CLI-spilled tool output only from this conversation's generated step files. */
export function resolveLargeToolOutput(
  text: string,
  conversationId?: string,
  brainDirectory = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
): string {
  const prefix = 'The output was large and was saved to: ';
  if (!conversationId || !/^[a-zA-Z0-9_-]+$/.test(conversationId) || !text.trim().startsWith(prefix)) return text;
  let fd: number | undefined;
  try {
    const uri = text.trim().slice(prefix.length).trim();
    if (!uri.startsWith('file:///') || /[\r\n]/.test(uri)) return text;
    const brain = fs.realpathSync(brainDirectory);
    const file = fs.realpathSync(fileURLToPath(uri));
    const parts = path.relative(brain, file).split(path.sep);
    if (parts.length !== 5 || parts[0] !== conversationId || parts[1] !== '.system_generated' || parts[2] !== 'steps' || !/^\d+$/.test(parts[3]!) || parts[4] !== 'output.txt') return text;
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_OUTPUT_BYTES) return text;
    // Bounded read also covers files growing after stat.
    const bytes = Buffer.alloc(MAX_OUTPUT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size === 0 || size > MAX_OUTPUT_BYTES) return text;
    return bytes.subarray(0, size).toString('utf8');
  } catch {
    return text;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
