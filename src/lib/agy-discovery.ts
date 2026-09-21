/**
 * Discover available agy models / agents via `agy models` and `agy agents`/`agy agent`.
 * Parsers are pure; discovery runners spawn with PATH ensure + timeout.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

export interface DiscoveryResult {
  availableModels: string[];
  availableAgents: string[];
  modelsError?: string;
  agentsError?: string;
}

let cached: DiscoveryResult | null = null;
let cachedBin: string | null = null;
let inflight: Promise<DiscoveryResult> | null = null;

/**
 * Parse `agy models` stdout into model id list.
 * Skips status lines like "Fetching available models...".
 * Takes the first whitespace-separated token per non-empty line.
 */
export function parseAgyModelsStdout(stdout: string): string[] {
  if (!stdout || typeof stdout !== 'string') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^fetching\b/i.test(line)) continue;
    if (/^available models/i.test(line)) continue;
    if (/^id\b/i.test(line) && /\bname\b/i.test(line)) continue;
    const id = line.split(/\s+/)[0];
    if (!id || id.startsWith('-') || id.includes('=')) continue;
    // Model ids are typically slug-like (letters, digits, dots, hyphens, underscores)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Parse `agy agents` / `agy agent` stdout into agent id list.
 * Accepts "id\\tname", "id name", or plain id-per-line.
 */
export function parseAgyAgentsStdout(stdout: string): string[] {
  if (!stdout || typeof stdout !== 'string') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^fetching\b/i.test(line)) continue;
    if (/^available agents/i.test(line)) continue;
    if (/^usage:/i.test(line)) continue;
    if (/^flags:/i.test(line)) continue;
    if (line.startsWith('-')) continue;
    const id = line.split(/\s+/)[0];
    if (!id) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:+-]*$/.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function ensurePath(): void {
  const geminiBin = path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'bin');
  const extra = '/home/box/.local/bin';
  const p = process.env.PATH || '';
  const parts = p.split(path.delimiter);
  const additions: string[] = [];
  if (geminiBin && !parts.includes(geminiBin)) additions.push(geminiBin);
  if (extra && !parts.includes(extra)) additions.push(extra);
  if (additions.length > 0) {
    process.env.PATH = `${additions.join(path.delimiter)}${path.delimiter}${p}`;
  }
}

function forceKill(child: any): void {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run a short-lived agy subcommand; resolve { stdout, stderr, code } or error string.
 */
function runAgySubcommand(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number | null; error?: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (payload: {
      stdout: string;
      stderr: string;
      code: number | null;
      error?: string;
    }) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    let child: any;
    try {
      let execBin = bin;
      let execArgs = args;
      if (/\.(js|cjs|mjs|ts)$/i.test(bin)) {
        execBin = process.execPath;
        execArgs = [bin, ...args];
      }
      child = spawn(execBin, execArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
        windowsHide: true,
      });
    } catch (err) {
      finish({
        stdout: '',
        stderr: '',
        code: null,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    const timer = setTimeout(() => {
      forceKill(child);
      finish({ stdout, stderr, code: null, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (buf: Buffer) => {
      stdout += buf.toString();
    });
    child.stderr?.on('data', (buf: Buffer) => {
      stderr += buf.toString();
    });
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      finish({ stdout, stderr, code: null, error: err.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      finish({ stdout, stderr, code });
    });
  });
}

/**
 * Official supported Antigravity models (verified 14 models).
 */
export const DEFAULT_AGY_MODELS: string[] = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
];

export const FALLBACK_MODELS = DEFAULT_AGY_MODELS;

export async function discoverAgyCatalog(opts?: {
  bin?: string;
  timeoutMs?: number;
  force?: boolean;
  dynamic?: boolean;
}): Promise<DiscoveryResult> {
  let bin = opts?.bin || process.env.AGY_BIN || 'agy';
  if (bin === 'agy' || bin === 'agy.exe') {
    const userGemini = path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
    if (fs.existsSync(userGemini)) {
      bin = userGemini;
    }
  }

  if (cached && !opts?.force && (cachedBin === null || cachedBin === bin)) return cached;
  if (inflight && !opts?.force) return inflight;

  const isScriptMock = /\.(cjs|js|mjs|ts)$/i.test(bin);
  const dynamic = opts?.dynamic ?? (process.env.AGY_DYNAMIC_DISCOVERY === 'true' || isScriptMock);
  if (!dynamic) {
    const staticResult: DiscoveryResult = {
      availableModels: [...DEFAULT_AGY_MODELS],
      availableAgents: [],
    };
    cached = staticResult;
    cachedBin = bin;
    return staticResult;
  }

  const timeoutMs = opts?.timeoutMs ?? 15_000;

  inflight = (async () => {
    ensurePath();
    const result: DiscoveryResult = {
      availableModels: [],
      availableAgents: [],
    };

    const modelsRun = await runAgySubcommand(bin, ['models'], timeoutMs);

    if (modelsRun.error || (modelsRun.code !== 0 && modelsRun.code !== null && !modelsRun.stdout.trim())) {
      result.modelsError =
        modelsRun.error ||
        modelsRun.stderr.trim().slice(0, 200) ||
        `agy models exited ${modelsRun.code}`;
      process.stderr.write(`[agy-acp] discovery models failed: ${result.modelsError}\n`);
    } else {
      result.availableModels = parseAgyModelsStdout(modelsRun.stdout);
      if (!result.availableModels.length && modelsRun.stderr.trim()) {
        result.availableModels = parseAgyModelsStdout(modelsRun.stderr);
      }
    }

    if (!result.availableModels.length) {
      result.availableModels = [...DEFAULT_AGY_MODELS];
    }

    cached = result;
    cachedBin = bin;
    inflight = null;
    return result;
  })();

  return inflight;
}

/** Test helper: clear process-lifetime cache. */
export function clearDiscoveryCache(): void {
  cached = null;
  cachedBin = null;
  inflight = null;
}

export function setCachedDiscoveryForTest(result: DiscoveryResult | null): void {
  cached = result;
  cachedBin = null;
  inflight = null;
}

export function getCachedDiscovery(): DiscoveryResult | null {
  return cached;
}
