/**
 * Rich content helpers: extract image paths from tool I/O and build ACP image blocks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  decodeFsPath,
  isPathAllowed,
  resolveAgainstCwd,
  type PathAllowlistRoots,
} from './path-allowlist.ts';

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

export interface FileToAcpImageOpts extends Partial<PathAllowlistRoots> {
  maxBytes?: number;
  /** When true and roots provided, enforce allowlist. Default: enforce when cwd set. */
  enforceAllowlist?: boolean;
}

export interface BuildRichToolContentOpts extends FileToAcpImageOpts {
  toolName?: string;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg']);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2MB

const PATH_RE =
  /(?:^|[\s"'`(\[=:])((?:\/|~\/|\.\/|\.\.\/)[^\s"'`)\]]+\.(?:png|jpe?g|webp|gif|bmp|svg))\b/gi;

// Windows drive-letter and UNC paths may contain spaces, so stop at the first
// supported image extension and require a normal text boundary afterwards.
const WINDOWS_PATH_RE =
  /(?:^|[\s"'`(\[=:])((?:[A-Za-z]:[\\/]|\\\\)[^<>"|?*\r\n]*?\.(?:png|jpe?g|webp|gif|bmp|svg))(?=$|[\s"'`)\]},;:.!?])/gi;

function decodePathValue(value: string): string {
  return decodeFsPath(value);
}

function normalizeImageCandidate(value: string): string {
  return decodePathValue(value).replace(/[.,;:!?)\\]}]+$/, '');
}

function isImagePath(value: string): boolean {
  const s = normalizeImageCandidate(value);
  const ext = path.extname(s).toLowerCase();
  if (!IMAGE_EXT.has(ext)) return false;

  return (
    path.isAbsolute(s) ||
    /^[A-Za-z]:[\\/]/.test(s) ||
    /^\\\\/.test(s) ||
    /^(?:~[\\/]|\.{1,2}[\\/])/.test(s)
  );
}

/**
 * Collect filesystem-looking image paths from a string or JSON-ish object.
 */
export function extractImagePaths(textOrObj: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: unknown) => {
    if (!p || typeof p !== 'string') return;
    const s = normalizeImageCandidate(p);
    if (!s || seen.has(s) || !isImagePath(s)) return;
    seen.add(s);
    out.push(s);
  };

  const walk = (v: unknown, depth = 0) => {
    if (depth > 8 || v == null) return;
    if (typeof v === 'string') {
      if (isImagePath(v)) add(v);
      for (const m of v.matchAll(PATH_RE)) add(m[1]);
      for (const m of v.matchAll(WINDOWS_PATH_RE)) add(m[1]);
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
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
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

function mimeForExt(ext: string): string {
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

function shouldEnforceAllowlist(opts: FileToAcpImageOpts): boolean {
  if (opts.enforceAllowlist === false) return false;
  if (opts.enforceAllowlist === true) return true;
  return Boolean(opts.cwd);
}

/**
 * Read an image file into an ACP ImageContent block (base64 data).
 * Skips if missing, oversized, or outside allowlisted roots (when cwd provided).
 * Relative paths resolve against opts.cwd (session cwd), not process.cwd().
 */
export function fileToAcpImageBlock(
  filePath: string,
  opts: FileToAcpImageOpts = {},
): AcpImageBlock | null {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  if (!filePath || typeof filePath !== 'string') return null;
  const normalizedPath = decodePathValue(filePath);

  if (shouldEnforceAllowlist(opts)) {
    const roots: PathAllowlistRoots = {
      cwd: opts.cwd!,
      additionalDirectories: opts.additionalDirectories,
      stagingDir: opts.stagingDir,
    };
    if (!isPathAllowed(normalizedPath, roots)) {
      return null;
    }
  }

  let abs: string;
  if (opts.cwd) {
    const resolved = resolveAgainstCwd(normalizedPath, opts.cwd);
    if (!resolved) return null;
    abs = resolved;
  } else {
    abs = path.resolve(normalizedPath);
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > maxBytes) {
    return null;
  }
  const ext = path.extname(abs);
  if (!IMAGE_EXT.has(ext.toLowerCase())) return null;
  let realAbs = abs;
  try {
    realAbs = fs.realpathSync(abs);
  } catch {
    /* keep abs */
  }
  const buf = fs.readFileSync(realAbs);
  return {
    type: 'image',
    mimeType: mimeForExt(ext),
    data: buf.toString('base64'),
    uri: pathToFileURL(realAbs).href,
  };
}

/**
 * Build ACP tool_call_update content entries: text + optional image blocks.
 */
export function buildRichToolContent(
  textOut: string,
  params?: unknown,
  output?: unknown,
  opts: BuildRichToolContentOpts = {},
): { content: ToolContentEntry[]; imagePaths: string[]; emittedImages: number } {
  const content: ToolContentEntry[] = [];
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
  const imagePaths = [...new Set(candidates)];
  let emittedImages = 0;
  const prefer =
    String(opts.toolName || '').toLowerCase() === 'generate_image' || imagePaths.length > 0;

  const imageOpts: FileToAcpImageOpts = {
    cwd: opts.cwd,
    additionalDirectories: opts.additionalDirectories,
    stagingDir: opts.stagingDir,
    maxBytes: opts.maxBytes,
    enforceAllowlist: opts.enforceAllowlist,
  };

  if (prefer) {
    for (const p of imagePaths) {
      const img = fileToAcpImageBlock(p, imageOpts);
      if (img) {
        content.push({ type: 'content', content: img });
        emittedImages++;
      } else {
        // Outside allowlist / missing / oversized — note only if file exists under no-enforce
        // or was denied; keep a short note when path looked real but was skipped.
        const exists =
          opts.cwd
            ? (() => {
                try {
                  const r = resolveAgainstCwd(p, opts.cwd!);
                  return r ? fs.existsSync(r) : false;
                } catch {
                  return false;
                }
              })()
            : fs.existsSync(p);
        if (exists) {
          content.push({
            type: 'content',
            content: {
              type: 'text',
              text: `[agy-acp] image at ${p} (not inlined; missing, >2MB, or outside session roots)`,
            },
          });
        }
      }
    }
  }

  return { content, imagePaths, emittedImages };
}

export { MAX_IMAGE_BYTES, IMAGE_EXT };
