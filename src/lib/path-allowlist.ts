/**
 * Path allowlist helpers for reading image/output files under session roots.
 * Handles Windows drive letters, UNC, and file:// URIs carefully.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface PathAllowlistRoots {
  cwd: string;
  additionalDirectories?: string[];
  stagingDir?: string;
}

/**
 * Decode file:// URI / percent-encoding into a filesystem path string
 * suitable for path.resolve (mirrors rich-content decode).
 */
export function decodeFsPath(value: string): string {
  let s = String(value || '').trim();
  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\//i, '');
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep */
    }
    if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
    else if (!/^[A-Za-z]:[\\/]/.test(s) && !s.startsWith('/') && !s.startsWith('\\')) {
      s = `//${s}`;
    }
  } else {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* keep */
    }
  }
  if (/^\/[A-Za-z]:[\\/]/.test(s)) s = s.slice(1);
  if (s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(os.homedir(), s.slice(2));
  }
  return s;
}

function tryRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      // Parent may exist even if leaf doesn't — still reject missing for reads.
      return path.resolve(p);
    } catch {
      return null;
    }
  }
}

function normalizeRoot(root: string): string | null {
  if (!root || typeof root !== 'string') return null;
  const decoded = decodeFsPath(root);
  const abs = path.isAbsolute(decoded) || /^[A-Za-z]:[\\/]/.test(decoded) || /^\\\\/.test(decoded)
    ? path.resolve(decoded)
    : path.resolve(decoded);
  try {
    return fs.realpathSync(abs);
  } catch {
    // Root may not exist yet (staging); use resolved absolute path.
    return abs;
  }
}

/**
 * Resolve candidate path against session cwd (not process.cwd()), then realpath.
 */
export function resolveAgainstCwd(filePath: string, cwd: string): string | null {
  if (!filePath || typeof filePath !== 'string') return null;
  const decoded = decodeFsPath(filePath);
  let abs: string;
  if (
    path.isAbsolute(decoded) ||
    /^[A-Za-z]:[\\/]/.test(decoded) ||
    /^\\\\/.test(decoded) ||
    /^\/\//.test(decoded)
  ) {
    abs = path.resolve(decoded);
  } else {
    abs = path.resolve(cwd, decoded);
  }
  return tryRealpath(abs);
}

function pathIsInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (!rel) return true; // same path
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * True when resolved realpath of filePath is under cwd, stagingDir, or additionalDirectories.
 * Missing files return false (caller should not read).
 */
export function isPathAllowed(filePath: string, roots: PathAllowlistRoots): boolean {
  if (!roots?.cwd) return false;
  const resolved = resolveAgainstCwd(filePath, roots.cwd);
  if (!resolved) return false;

  // Must exist as a file for allow (reads); use realpath of existing file.
  let realFile: string;
  try {
    realFile = fs.realpathSync(resolved);
    if (!fs.statSync(realFile).isFile()) return false;
  } catch {
    return false;
  }

  const allowed: string[] = [];
  const cwdRoot = normalizeRoot(roots.cwd);
  if (cwdRoot) allowed.push(cwdRoot);

  const staging =
    roots.stagingDir ||
    (roots.cwd ? path.join(roots.cwd, '.agy-acp-staging') : undefined);
  if (staging) {
    const s = normalizeRoot(staging);
    if (s) allowed.push(s);
  }

  for (const d of roots.additionalDirectories || []) {
    const r = normalizeRoot(d);
    if (r) allowed.push(r);
  }

  for (const root of allowed) {
    if (pathIsInside(realFile, root)) return true;
  }
  return false;
}

export { pathIsInside };
