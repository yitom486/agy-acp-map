/**
 * Rich content helpers: extract image paths from tool I/O and build ACP image blocks.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface AcpImageBlock {
  type: 'image';
  mimeType: string;
  data: string;
  uri?: string;
}

export interface AcpTextBlock {
  type: 'text';
  text: string;
}

export type AcpContentBlock = AcpImageBlock | AcpTextBlock | Record<string, unknown>;

export interface ToolContentEntry {
  type: 'content';
  content: AcpContentBlock;
}


const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB

const PATH_RE =
  /(?:^|[\s"'`(\[=:])((?:\/|~\/|\.\/|\.\.\/)[^\s"'`)\]]+\.(?:png|jpe?g|webp|gif|bmp|svg))\b/gi;

/**
 * Collect filesystem-looking image paths from a string or JSON-ish object.
 * @param {unknown} textOrObj
 * @returns {string[]}
 */
export function extractImagePaths(textOrObj: unknown): string[] {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p || typeof p !== 'string') return;
    let s = p.trim().replace(/^file:\/\//, '');
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep */
    }
    // strip trailing punctuation
    s = s.replace(/[.,;:!?)]+$/, '');
    if (!s || seen.has(s)) return;
    const ext = path.extname(s).toLowerCase();
    if (!IMAGE_EXT.has(ext)) return;
    seen.add(s);
    out.push(s);
  };

  const walk = (v, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') {
      // whole string is a path?
      if (/[\\/]/.test(v) && IMAGE_EXT.has(path.extname(v).toLowerCase())) {
        add(v);
      }
      for (const m of v.matchAll(PATH_RE)) add(m[1]);
      // markdown file links
      for (const m of v.matchAll(/\[[^\]]*\]\(\s*file:\/\/([^)\s]+)\s*\)/gi)) add(m[1]);
      for (const m of v.matchAll(/\[[^\]]*\]\(\s*(\/?[^)\s]+\.(?:png|jpe?g|webp|gif))\s*\)/gi))
        add(m[1]);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        const kl = k.toLowerCase();
        if (
          typeof val === 'string' &&
          (kl.includes('path') ||
            kl.includes('file') ||
            kl.includes('image') ||
            kl.includes('uri') ||
            kl.includes('url') ||
            kl === 'output')
        ) {
          add(val);
        }
        walk(val, depth + 1);
      }
    }
  };

  walk(textOrObj);
  return out;
}

function mimeForExt(ext) {
  switch (ext.toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    case '.bmp':
      return 'image/bmp';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Read an image file into an ACP ImageContent block (base64 data).
 * Skips if missing or larger than MAX_IMAGE_BYTES.
 * @param {string} filePath
 * @param {{ maxBytes?: number }} [opts]
 * @returns {{ type: 'image', mimeType: string, data: string, uri?: string } | null}
 */
export function fileToAcpImageBlock(filePath: string, opts: { maxBytes?: number } = {}): AcpImageBlock | null {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  if (!filePath || typeof filePath !== 'string') return null;
  let abs = filePath;
  if (filePath.startsWith('file://')) {
    abs = decodeURIComponent(filePath.slice('file://'.length));
  }
  abs = path.resolve(abs);
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > maxBytes) {
    return null; // caller should keep path text only
  }
  const ext = path.extname(abs);
  if (!IMAGE_EXT.has(ext.toLowerCase())) return null;
  const buf = fs.readFileSync(abs);
  return {
    type: 'image',
    mimeType: mimeForExt(ext),
    data: buf.toString('base64'),
    uri: `file://${abs}`,
  };
}

/**
 * Build ACP tool_call_update content entries: text + optional image blocks.
 * @param {string} textOut
 * @param {unknown} [params]
 * @param {unknown} [output]
 * @param {{ toolName?: string }} [opts]
 * @returns {{ content: object[], imagePaths: string[], emittedImages: number }}
 */
export function buildRichToolContent(textOut: string, params?: unknown, output?: unknown, opts: { toolName?: string } = {}): { content: ToolContentEntry[]; imagePaths: string[]; emittedImages: number } {
  /** @type {object[]} */
  const content = [];
  if (textOut) {
    content.push({
      type: 'content',
      content: { type: 'text', text: textOut },
    });
  }

  const candidates = [
    ...extractImagePaths(textOut),
    ...extractImagePaths(params),
    ...extractImagePaths(output),
  ];
  // de-dupe preserving order
  const imagePaths = [...new Set(candidates)];
  let emittedImages = 0;
  const prefer =
    String(opts.toolName || '').toLowerCase() === 'generate_image' || imagePaths.length > 0;

  if (prefer) {
    for (const p of imagePaths) {
      const img = fileToAcpImageBlock(p);
      if (img) {
        content.push({ type: 'content', content: img });
        emittedImages++;
      } else if (fs.existsSync(p)) {
        // oversized or unreadable — note path only (already in textOut usually)
        content.push({
          type: 'content',
          content: {
            type: 'text',
            text: `[agy-acp] image at ${p} (not inlined; missing or >2MB)`,
          },
        });
      }
    }
  }

  return { content, imagePaths, emittedImages };
}

export { MAX_IMAGE_BYTES, IMAGE_EXT };
