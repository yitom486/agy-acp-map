/**
 * Normalize ACP ContentBlock[] into text-only agy stdin, staging binary/media to disk.
 * Enforces per-blob and per-turn size limits; provides staging cleanup helpers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface NormalizeOpts {
  cwd: string;
  stagingDir?: string;
  /** Max decoded bytes for a single blob (default 8MB). */
  maxBlobBytes?: number;
  /** Max total decoded bytes staged this call (default 32MB). */
  maxTotalBytes?: number;
}

export interface NormalizeResult {
  text: string;
  notes: string[];
  stagedFiles: string[];
  /** Total bytes written this normalize call. */
  stagedBytes: number;
  /** True when a blob was rejected for size. */
  sizeRejected: boolean;
}

const STAGING_DIRNAME = '.agy-acp-staging';
export const DEFAULT_MAX_BLOB_BYTES = 8 * 1024 * 1024; // 8MB
export const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024 * 1024; // 32MB

/**
 * @param {unknown[]} blocks
 * @param {{ cwd: string, stagingDir?: string }} opts
 */
export async function normalizePromptBlocks(
  blocks: unknown[],
  opts: NormalizeOpts,
): Promise<NormalizeResult> {
  return normalizePromptBlocksSync(blocks, opts);
}

/**
 * Sync convenience wrapping the same logic.
 */
export function normalizePromptBlocksSync(
  blocks: unknown[],
  opts: NormalizeOpts,
): NormalizeResult {
  const notes: string[] = [];
  const parts: string[] = [];
  const stagedFiles: string[] = [];
  let stagedBytes = 0;
  let sizeRejected = false;
  const cwd = opts?.cwd;
  if (!cwd || typeof cwd !== 'string') {
    return {
      text: '',
      notes: ['cwd required for normalizePromptBlocks'],
      stagedFiles,
      stagedBytes: 0,
      sizeRejected: false,
    };
  }
  const stagingDir = opts.stagingDir || path.join(cwd, STAGING_DIRNAME);
  const maxBlob = opts.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  if (!Array.isArray(blocks)) {
    return {
      text: '',
      notes: ['prompt was not an array'],
      stagedFiles,
      stagedBytes: 0,
      sizeRejected: false,
    };
  }

  ensureDir(stagingDir);

  const budget = {
    maxBlob,
    maxTotal,
    used: 0,
    reject: () => {
      sizeRejected = true;
    },
    add: (n: number) => {
      stagedBytes += n;
      budget.used += n;
    },
  };

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const type = (b as { type?: string }).type;

    if (type === 'text' && typeof (b as { text?: string }).text === 'string') {
      parts.push((b as { text: string }).text);
      continue;
    }

    if (type === 'resource' && (b as { resource?: unknown }).resource) {
      const r = (b as { resource: Record<string, unknown> }).resource;
      if (typeof r.text === 'string') {
        const uri = r.uri ? `[resource ${r.uri}]\n` : '[resource]\n';
        parts.push(uri + r.text);
      } else if (r.blob && typeof r.blob === 'string') {
        const mime = (r.mimeType as string) || 'application/octet-stream';
        const filePath = stageBase64Sync(
          stagingDir,
          r.blob,
          mime,
          stagedFiles,
          notes,
          budget,
        );
        if (filePath) {
          parts.push(
            `User attached a resource file at: ${filePath}\nPlease open/view that file and answer based on what you see.`,
          );
        }
      } else {
        notes.push(`skipped resource without text (${r.uri || 'unknown'})`);
      }
      continue;
    }

    if (type === 'resource_link') {
      const bl = b as { uri?: string; name?: string };
      notes.push(`resource_link mentioned ${bl.uri || ''}`);
      if (bl.uri) parts.push(`[link: ${bl.uri}]`);
      if (bl.name) parts.push(`[resource_link name: ${bl.name}]`);
      continue;
    }

    if (type === 'image') {
      const filePath = stageImageBlockSync(b, stagingDir, stagedFiles, notes, budget);
      if (filePath) {
        parts.push(
          `User attached an image file at: ${filePath}\nPlease open/view that file and answer based on what you see.`,
        );
      }
      continue;
    }

    if (type === 'audio') {
      const filePath = stageAudioBlockSync(b, stagingDir, stagedFiles, notes, budget);
      if (filePath) {
        parts.push(
          `User attached an audio file at: ${filePath}\nPlease open/view that file if useful, or note that audio may not be playable.`,
        );
      } else {
        notes.push('skipped audio block (could not stage)');
      }
      continue;
    }

    notes.push(`skipped unsupported block type: ${type || typeof b}`);
  }

  return { text: parts.join('\n\n'), notes, stagedFiles, stagedBytes, sizeRejected };
}

export async function normalizePromptBlocksAsync(
  blocks: unknown[],
  opts: NormalizeOpts,
): Promise<NormalizeResult> {
  return normalizePromptBlocksSync(blocks, opts);
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function extForMime(mime: string, fallback?: string) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('svg')) return '.svg';
  if (m.includes('wav')) return '.wav';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('webm')) return '.webm';
  if (m.includes('mp4')) return '.mp4';
  return fallback || '.bin';
}

interface StageBudget {
  maxBlob: number;
  maxTotal: number;
  used: number;
  reject: () => void;
  add: (n: number) => void;
}

function decodeDataPayload(data: unknown, notes: string[]) {
  if (data == null) return null;
  let s = String(data);
  const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
  if (dataUrl) {
    const mime = dataUrl[1] || '';
    const isB64 = Boolean(dataUrl[2]);
    const payload = dataUrl[3];
    try {
      const buf = isB64
        ? Buffer.from(payload!, 'base64')
        : Buffer.from(decodeURIComponent(payload!));
      return { buf, mime };
    } catch (e: unknown) {
      notes.push(`failed to decode data URL: ${(e as Error)?.message || e}`);
      return null;
    }
  }
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 0) return null;
    return { buf, mime: '' };
  } catch (e: unknown) {
    notes.push(`failed to decode base64: ${(e as Error)?.message || e}`);
    return null;
  }
}

function stageBase64Sync(
  stagingDir: string,
  data: unknown,
  mime: string,
  stagedFiles: string[],
  notes: string[],
  budget: StageBudget,
) {
  ensureDir(stagingDir);
  const decoded = decodeDataPayload(data, notes);
  if (!decoded) {
    notes.push('could not decode blob/base64');
    return null;
  }
  if (decoded.buf.length > budget.maxBlob) {
    notes.push(
      `blob exceeds max single size (${decoded.buf.length} > ${budget.maxBlob} bytes)`,
    );
    budget.reject();
    return null;
  }
  if (budget.used + decoded.buf.length > budget.maxTotal) {
    notes.push(
      `blob would exceed max total staging size (${budget.used + decoded.buf.length} > ${budget.maxTotal} bytes)`,
    );
    budget.reject();
    return null;
  }
  const ext = extForMime(decoded.mime || mime, '.bin');
  const filePath = path.join(stagingDir, `${randomUUID()}${ext}`);
  fs.writeFileSync(filePath, decoded.buf);
  stagedFiles.push(filePath);
  budget.add(decoded.buf.length);
  return filePath;
}

function stageImageBlockSync(
  b: unknown,
  stagingDir: string,
  stagedFiles: string[],
  notes: string[],
  budget: StageBudget,
) {
  const raw = b as Record<string, unknown>;
  const img =
    raw.image && typeof raw.image === 'object'
      ? { ...raw, ...(raw.image as object) }
      : raw;
  const mime =
    (img.mimeType as string) || (img.mime_type as string) || 'image/png';

  if (typeof img.uri === 'string' && img.uri && !img.data) {
    let u = img.uri;
    if (u.startsWith('file://')) u = decodeURIComponent(u.slice('file://'.length));
    if (u.startsWith('data:')) {
      return stageBase64Sync(stagingDir, u, mime, stagedFiles, notes, budget);
    }
    if (path.isAbsolute(u) && fs.existsSync(u)) {
      notes.push(`image uri referenced in place: ${u}`);
      return u;
    }
    notes.push(`image uri not local absolute: ${img.uri}`);
    return null;
  }

  if (img.data != null) {
    return stageBase64Sync(stagingDir, img.data, mime, stagedFiles, notes, budget);
  }
  const source = img.source as { type?: string; data?: string; media_type?: string; mimeType?: string } | undefined;
  if (source?.type === 'base64' && source.data) {
    return stageBase64Sync(
      stagingDir,
      source.data,
      source.media_type || source.mimeType || mime,
      stagedFiles,
      notes,
      budget,
    );
  }
  notes.push('image block missing data/uri');
  return null;
}

function stageAudioBlockSync(
  b: unknown,
  stagingDir: string,
  stagedFiles: string[],
  notes: string[],
  budget: StageBudget,
) {
  const raw = b as Record<string, unknown>;
  const aud =
    raw.audio && typeof raw.audio === 'object'
      ? { ...raw, ...(raw.audio as object) }
      : raw;
  const mime =
    (aud.mimeType as string) || (aud.mime_type as string) || 'audio/wav';
  if (typeof aud.uri === 'string' && aud.uri.startsWith('file://')) {
    const u = decodeURIComponent(aud.uri.slice('file://'.length));
    if (fs.existsSync(u)) return u;
  }
  if (aud.data != null) {
    return stageBase64Sync(stagingDir, aud.data, mime, stagedFiles, notes, budget);
  }
  return null;
}

/**
 * Remove staging files. Honors AGY_ACP_KEEP_STAGING=1 to skip cleanup.
 * @param filesOrDir list of files to delete, or a staging directory to empty
 */
export function cleanupStaging(
  filesOrDir: string[] | string,
  opts?: { keep?: boolean },
): { removed: string[]; skipped: boolean } {
  const keep =
    opts?.keep === true ||
    process.env.AGY_ACP_KEEP_STAGING === '1' ||
    process.env.AGY_ACP_KEEP_STAGING === 'true';
  if (keep) {
    return { removed: [], skipped: true };
  }

  const removed: string[] = [];
  const targets: string[] = [];

  if (typeof filesOrDir === 'string') {
    const dir = filesOrDir;
    if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
      for (const name of fs.readdirSync(dir)) {
        targets.push(path.join(dir, name));
      }
    }
  } else if (Array.isArray(filesOrDir)) {
    targets.push(...filesOrDir);
  }

  for (const f of targets) {
    try {
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        fs.unlinkSync(f);
        removed.push(f);
      }
    } catch {
      /* ignore */
    }
  }
  return { removed, skipped: false };
}

/**
 * Clean `<cwd>/.agy-acp-staging` for a session (all files in that dir).
 */
export function cleanupSessionStaging(
  cwd: string,
  opts?: { keep?: boolean; stagingDir?: string },
): { removed: string[]; skipped: boolean } {
  const dir = opts?.stagingDir || path.join(cwd, STAGING_DIRNAME);
  return cleanupStaging(dir, opts);
}

export {
  STAGING_DIRNAME,
};
