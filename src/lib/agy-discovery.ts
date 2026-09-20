/**
 * Discover available agy models / agents via `agy models` and `agy agents`/`agy agent`.
 * Parsers are pure; discovery runners spawn with PATH ensure + timeout.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

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
  const extra = '/home/box/.local/bin';
  const p = process.env.PATH || '';
  if (!p.split(path.delimiter).includes(extra)) {
    process.env.PATH = `${extra}${path.delimiter}${p}`;
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
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
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
export async function discoverAgyCatalog(opts?: {
  bin?: string;
  timeoutMs?: number;
  force?: boolean;
}): Promise<DiscoveryResult> {
  if (cached && !opts?.force) return cached;
  if (inflight && !opts?.force) return inflight;

  const bin = opts?.bin || process.env.AGY_BIN || 'agy';
  const timeoutMs = opts?.timeoutMs ?? 10_000;

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
        // Some CLIs print to stderr
        result.availableModels = parseAgyModelsStdout(modelsRun.stderr);
      }
    }

    // Prefer `agy agents`, fall back to `agy agent`
    let agentsRun = await runAgySubcommand(bin, ['agents'], timeoutMs);
    if (
      agentsRun.error ||
      (agentsRun.code !== 0 && !agentsRun.stdout.trim() && !parseAgyAgentsStdout(agentsRun.stderr).length)
    ) {
      agentsRun = await runAgySubcommand(bin, ['agent'], timeoutMs);
    }
    if (agentsRun.error || (agentsRun.code !== 0 && agentsRun.code !== null && !agentsRun.stdout.trim())) {
      // Empty success (code 0, no output) is fine — just empty list
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

export function getCachedDiscovery(): DiscoveryResult | null {
  return cached;
}
