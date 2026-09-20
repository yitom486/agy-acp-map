/**
 * Normalize ACP ContentBlock[] into text-only agy stdin, staging binary/media to disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface NormalizeOpts {
  cwd: string;
  stagingDir?: string;
}

export interface NormalizeResult {
  text: string;
  notes: string[];
  stagedFiles: string[];
}


const STAGING_DIRNAME = '.agy-acp-staging';

/**
 * @param {unknown[]} blocks
 * @param {{ cwd: string, stagingDir?: string }} opts
 * @returns {Promise<{ text: string, notes: string[], stagedFiles: string[] }>}
 */
export async function normalizePromptBlocks(blocks: unknown[], opts: NormalizeOpts): Promise<NormalizeResult> {
  const notes = [];
  const parts = [];
  const stagedFiles = [];
  const cwd = opts?.cwd;
  if (!cwd || typeof cwd !== 'string') {
    return { text: '', notes: ['cwd required for normalizePromptBlocks'], stagedFiles };
  }
  const stagingDir = opts.stagingDir || path.join(cwd, STAGING_DIRNAME);

  if (!Array.isArray(blocks)) {
    return { text: '', notes: ['prompt was not an array'], stagedFiles };
  }

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const type = b.type;

    if (type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
      continue;
    }

    if (type === 'resource' && b.resource) {
      const r = b.resource;
      if (typeof r.text === 'string') {
        const uri = r.uri ? `[resource ${r.uri}]\n` : '[resource]\n';
        parts.push(uri + r.text);
      } else if (r.blob && typeof r.blob === 'string') {
        // binary embedded resource — stage as file
        const mime = r.mimeType || 'application/octet-stream';
        const filePath = await stageBase64(stagingDir, r.blob, mime, stagedFiles, notes);
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
      notes.push(`resource_link mentioned ${b.uri || ''}`);
      if (b.uri) parts.push(`[link: ${b.uri}]`);
      if (b.name) parts.push(`[resource_link name: ${b.name}]`);
      continue;
    }

    if (type === 'image') {
      const filePath = await stageImageBlock(b, stagingDir, stagedFiles, notes);
      if (filePath) {
        parts.push(
          `User attached an image file at: ${filePath}\nPlease open/view that file and answer based on what you see.`,
        );
      }
      continue;
    }

    if (type === 'audio') {
      const filePath = await stageAudioBlock(b, stagingDir, stagedFiles, notes);
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

  return { text: parts.join('\n\n'), notes, stagedFiles };
}

/**
 * Sync convenience wrapping the same logic (no await needed for callers that prefer sync).
 * @param {unknown[]} blocks
 * @param {{ cwd: string, stagingDir?: string }} opts
 */
export function normalizePromptBlocksSync(blocks: unknown[], opts: NormalizeOpts): NormalizeResult {
  // Implementation is sync-capable; expose sync API for server.
  const notes = [];
  const parts = [];
  const stagedFiles = [];
  const cwd = opts?.cwd;
  if (!cwd || typeof cwd !== 'string') {
    return { text: '', notes: ['cwd required for normalizePromptBlocks'], stagedFiles };
  }
  const stagingDir = opts.stagingDir || path.join(cwd, STAGING_DIRNAME);

  if (!Array.isArray(blocks)) {
    return { text: '', notes: ['prompt was not an array'], stagedFiles };
  }

  ensureDir(stagingDir);

  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const type = b.type;

    if (type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
      continue;
    }

    if (type === 'resource' && b.resource) {
      const r = b.resource;
      if (typeof r.text === 'string') {
        const uri = r.uri ? `[resource ${r.uri}]\n` : '[resource]\n';
        parts.push(uri + r.text);
      } else if (r.blob && typeof r.blob === 'string') {
        const mime = r.mimeType || 'application/octet-stream';
        const filePath = stageBase64Sync(stagingDir, r.blob, mime, stagedFiles, notes);
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
      notes.push(`resource_link mentioned ${b.uri || ''}`);
      if (b.uri) parts.push(`[link: ${b.uri}]`);
      if (b.name) parts.push(`[resource_link name: ${b.name}]`);
      continue;
    }

    if (type === 'image') {
      const filePath = stageImageBlockSync(b, stagingDir, stagedFiles, notes);
      if (filePath) {
        parts.push(
          `User attached an image file at: ${filePath}\nPlease open/view that file and answer based on what you see.`,
        );
      }
      continue;
    }

    if (type === 'audio') {
      const filePath = stageAudioBlockSync(b, stagingDir, stagedFiles, notes);
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

  return { text: parts.join('\n\n'), notes, stagedFiles };
}

export async function normalizePromptBlocksAsync(blocks: unknown[], opts: NormalizeOpts): Promise<NormalizeResult> {
  return normalizePromptBlocksSync(blocks, opts);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function extForMime(mime, fallback) {
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

function decodeDataPayload(data, notes) {
  if (data == null) return null;
  let s = String(data);
  // data URL
  const dataUrl = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(s);
  if (dataUrl) {
    const mime = dataUrl[1] || '';
    const isB64 = Boolean(dataUrl[2]);
    const payload = dataUrl[3];
    try {
      const buf = isB64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload));
      return { buf, mime };
    } catch (e) {
      notes.push(`failed to decode data URL: ${e?.message || e}`);
      return null;
    }
  }
  // raw base64
  try {
    const buf = Buffer.from(s, 'base64');
    // heuristic: if re-encode roughly matches length, treat as base64
    if (buf.length === 0) return null;
    return { buf, mime: '' };
  } catch (e) {
    notes.push(`failed to decode base64: ${e?.message || e}`);
    return null;
  }
}

function stageBase64Sync(stagingDir, data, mime, stagedFiles, notes) {
  ensureDir(stagingDir);
  const decoded = decodeDataPayload(data, notes);
  if (!decoded) {
    notes.push('could not decode blob/base64');
    return null;
  }
  const ext = extForMime(decoded.mime || mime, '.bin');
  const filePath = path.join(stagingDir, `${randomUUID()}${ext}`);
  fs.writeFileSync(filePath, decoded.buf);
  stagedFiles.push(filePath);
  return filePath;
}

async function stageBase64(stagingDir, data, mime, stagedFiles, notes) {
  return stageBase64Sync(stagingDir, data, mime, stagedFiles, notes);
}

function stageImageBlockSync(b, stagingDir, stagedFiles, notes) {
  // Shapes: {type:'image', data, mimeType} | {uri} | nested {image:{...}} | {source:{...}}
  const img = b.image && typeof b.image === 'object' ? { ...b, ...b.image } : b;
  const mime = img.mimeType || img.mime_type || 'image/png';

  if (typeof img.uri === 'string' && img.uri && !img.data) {
    // file URI or path — reference without copying when absolute file
    let u = img.uri;
    if (u.startsWith('file://')) u = decodeURIComponent(u.slice('file://'.length));
    if (u.startsWith('data:')) {
      return stageBase64Sync(stagingDir, u, mime, stagedFiles, notes);
    }
    if (path.isAbsolute(u) && fs.existsSync(u)) {
      notes.push(`image uri referenced in place: ${u}`);
      return u;
    }
    // relative / remote — try copy if local exists else mention
    notes.push(`image uri not local absolute: ${img.uri}`);
    return null;
  }

  if (img.data != null) {
    return stageBase64Sync(stagingDir, img.data, mime, stagedFiles, notes);
  }
  if (img.source?.type === 'base64' && img.source.data) {
    return stageBase64Sync(
      stagingDir,
      img.source.data,
      img.source.media_type || img.source.mimeType || mime,
      stagedFiles,
      notes,
    );
  }
  notes.push('image block missing data/uri');
  return null;
}

async function stageImageBlock(b, stagingDir, stagedFiles, notes) {
  return stageImageBlockSync(b, stagingDir, stagedFiles, notes);
}

function stageAudioBlockSync(b, stagingDir, stagedFiles, notes) {
  const aud = b.audio && typeof b.audio === 'object' ? { ...b, ...b.audio } : b;
  const mime = aud.mimeType || aud.mime_type || 'audio/wav';
  if (typeof aud.uri === 'string' && aud.uri.startsWith('file://')) {
    const u = decodeURIComponent(aud.uri.slice('file://'.length));
    if (fs.existsSync(u)) return u;
  }
  if (aud.data != null) {
    return stageBase64Sync(stagingDir, aud.data, mime, stagedFiles, notes);
  }
  return null;
}

async function stageAudioBlock(b, stagingDir, stagedFiles, notes) {
  return stageAudioBlockSync(b, stagingDir, stagedFiles, notes);
}

export { STAGING_DIRNAME };
