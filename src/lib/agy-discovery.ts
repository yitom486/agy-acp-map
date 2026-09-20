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
    let child;
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
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      finish({ stdout, stderr, code: null, error: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (buf) => {
      stdout += buf.toString();
    });
    child.stderr?.on('data', (buf) => {
      stderr += buf.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ stdout, stderr, code: null, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ stdout, stderr, code });
    });
  });
}

/**
 * Discover models + agents once per process. Failures → empty arrays + error notes.
 */
const FALLBACK_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-3.7-flash-high',
  'gemini-3.6-flash-high',
  'gemini-3.1-pro-high',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
];

export async function discoverAgyCatalog(opts?: {
  bin?: string;
  timeoutMs?: number;
  force?: boolean;
}): Promise<DiscoveryResult> {
  if (cached && !opts?.force) return cached;
  if (inflight && !opts?.force) return inflight;

  let bin = opts?.bin || process.env.AGY_BIN || 'agy';
  if (bin === 'agy' || bin === 'agy.exe') {
    const userGemini = path.join(process.env.USERPROFILE || process.env.HOME || '', '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
    if (fs.existsSync(userGemini)) {
      bin = userGemini;
    }
  }
  const timeoutMs = opts?.timeoutMs ?? 15_000;

  inflight = (async () => {
    ensurePath();
    const result: DiscoveryResult = {
      availableModels: [],
      availableAgents: [],
    };

    // Run models and agents discovery concurrently
    const [modelsRun, agentsRun] = await Promise.all([
      runAgySubcommand(bin, ['models'], timeoutMs),
      runAgySubcommand(bin, ['agents'], timeoutMs).then(async (res) => {
        if (res.error || (res.code !== 0 && !res.stdout.trim() && !parseAgyAgentsStdout(res.stderr).length)) {
          return runAgySubcommand(bin, ['agent'], timeoutMs);
        }
        return res;
      }),
    ]);

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

    // If availableModels is still empty, apply high-performance defaults
    if (!result.availableModels.length) {
      result.availableModels = [...FALLBACK_MODELS];
    }

    if (agentsRun.error || (agentsRun.code !== 0 && agentsRun.code !== null && !agentsRun.stdout.trim())) {
      if (agentsRun.error || agentsRun.code !== 0) {
        result.agentsError =
          agentsRun.error ||
          agentsRun.stderr.trim().slice(0, 200) ||
          `agy agents exited ${agentsRun.code}`;
        process.stderr.write(`[agy-acp] discovery agents failed: ${result.agentsError}\n`);
      }
    } else {
      result.availableAgents = parseAgyAgentsStdout(agentsRun.stdout);
      if (!result.availableAgents.length) {
        result.availableAgents = parseAgyAgentsStdout(agentsRun.stderr);
      }
    }

    cached = result;
    inflight = null;
    return result;
  })();

  return inflight;
}

/** Test helper: clear process-lifetime cache. */
export function clearDiscoveryCache(): void {
  cached = null;
  inflight = null;
}

export function setCachedDiscoveryForTest(result: DiscoveryResult | null): void {
  cached = result;
  inflight = null;
}

export function getCachedDiscovery(): DiscoveryResult | null {
  return cached;
}
