import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Restore CLI-spilled tool output only from this conversation's generated step files. */
export function resolveLargeToolOutput(
  text: string,
  conversationId?: string,
  brainDirectory = process.env.AGY_ACP_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
  stepIndex?: number,
): string {
  const fallback = text;
  const prefix = 'The output was large and was saved to: ';
  if (!conversationId || !/^[a-zA-Z0-9_-]+$/.test(conversationId)) return text;
  if (!text.trim() && Number.isSafeInteger(stepIndex) && stepIndex! >= 0) {
    text = prefix + pathToFileURL(path.join(brainDirectory, conversationId, '.system_generated', 'steps', String(stepIndex), 'output.txt')).href;
  } else if (!text.trim().startsWith(prefix)) return text;
  let fd: number | undefined;
  try {
    const uri = text.trim().slice(prefix.length).trim();
    if (!uri.startsWith('file:///') || /[\r\n]/.test(uri)) return fallback;
    const brain = fs.realpathSync(brainDirectory);
    const file = fs.realpathSync(fileURLToPath(uri));
    const parts = path.relative(brain, file).split(path.sep);
    if (parts.length !== 5 || parts[0] !== conversationId || parts[1] !== '.system_generated' || parts[2] !== 'steps' || !/^\d+$/.test(parts[3]!) || parts[4] !== 'output.txt') return fallback;
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_OUTPUT_BYTES) return fallback;
    // Bounded read also covers files growing after stat.
    const bytes = Buffer.alloc(MAX_OUTPUT_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size === 0 || size > MAX_OUTPUT_BYTES) return fallback;
    return bytes.subarray(0, size).toString('utf8');
  } catch {
    return fallback;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}


/** Optional session extension: repair only tool IDs supplied by the owning client. */
export function recoverToolOutputMeta(conversationId: string | undefined, params: any, brainDirectory?: string) {
  const ids = params?._meta?.toolOutputRecovery?.toolCallIds;
  if (!Array.isArray(ids) || ids.length > 20) return {};
  const outputs: Array<{toolCallId:string;text:string}> = [];
  let total = 0;
  for (const id of new Set(ids)) {
    if (typeof id !== 'string') continue;
    const match = /^agy-t[0-9]+-s([0-9]+)$/.exec(id);
    if (!match) continue;
    const text = resolveLargeToolOutput('', conversationId, brainDirectory, Number(match[1]));
    const bytes = Buffer.byteLength(text);
    if (!text || bytes > 128 * 1024 || total + bytes > 256 * 1024) continue;
    outputs.push({toolCallId:id,text}); total += bytes;
  }
  return outputs.length ? {toolOutputRecovery:{outputs}} : {};
}
