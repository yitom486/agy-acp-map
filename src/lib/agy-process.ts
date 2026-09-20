/**
 * Cross-platform agy child-process supervision:
 * generation tokens, graceful→force kill, stale NDJSON ignore, spawn error handling.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export const DEFAULT_GRACE_MS = 2000;
export const DEFAULT_WAIT_EXIT_MS = 5000;

export interface AgyProcessCallbacks {
  /** Parsed NDJSON object from stdout; only invoked when generation is still current. */
  onEvent: (obj: unknown, generation: number) => void;
  onStderr?: (chunk: string, generation: number) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null, generation: number) => void;
  onError?: (err: Error, generation: number) => void;
  /** Raw bad line (optional logging). */
  onBadLine?: (line: string, generation: number) => void;
}

export interface SpawnAgyOptions extends AgyProcessCallbacks {
  bin: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Optional override; manager increments its own generation when omitted. */
  generation?: number;
}

/**
 * Per-session process supervisor. Tracks generation so late lines from a killed
 * child are ignored after a respawn.
 */
export class AgyProcessManager {
  private child: ChildProcess | null = null;
  private generation = 0;
  private killInFlight: Promise<void> | null = null;

  get currentChild(): ChildProcess | null {
    return this.child;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  isAlive(): boolean {
    const c = this.child;
    return Boolean(c && !c.killed && c.exitCode === null && c.signalCode == null);
  }

  isWritable(): boolean {
    return this.isAlive() && Boolean(this.child?.stdin?.writable);
  }

  /**
   * Kill any existing child (await exit), then spawn a new one with a fresh generation.
   */
  async spawn(opts: SpawnAgyOptions): Promise<{ child: ChildProcess; generation: number }> {
    await this.kill({ awaitExit: true });

    this.generation += 1;
    const gen = opts.generation ?? this.generation;
    this.generation = gen;

    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env ?? { ...process.env },
      windowsHide: true,
    });

    this.child = child;

    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (gen !== this.generation || this.child !== child) return;
      const t = line.trim();
      if (!t) return;
      let obj: unknown;
      try {
        obj = JSON.parse(t);
      } catch {
        opts.onBadLine?.(t, gen);
        return;
      }
      opts.onEvent(obj, gen);
    });

    child.stderr?.on('data', (buf: Buffer | string) => {
      if (gen !== this.generation || this.child !== child) return;
      opts.onStderr?.(buf.toString(), gen);
    });

    child.stdin?.on('error', () => {
      // Swallow EPIPE / closed pipe errors to prevent process crash
    });

    child.on('error', (err: Error) => {
      // Always notify for this generation so callers can idle/error even if
      // another spawn already replaced child (shouldn't happen mid-error).
      opts.onError?.(err, gen);
      if (this.child === child) {
        this.child = null;
      }
    });

    child.on('exit', (code, signal) => {
      rl.close();
      if (this.child === child) {
        this.child = null;
      }
      opts.onExit?.(code, signal, gen);
    });

    return { child, generation: gen };
  }

  /**
   * Unified kill used by cancel, set_config_option, close, shutdown.
   * SIGINT → wait → SIGTERM → wait → force (SIGKILL / taskkill on Windows).
   */
  async kill(opts?: {
    graceMs?: number;
    awaitExit?: boolean;
    waitExitMs?: number;
  }): Promise<void> {
    if (this.killInFlight) {
      await this.killInFlight;
      return;
    }
    const child = this.child;
    if (!child) return;

    const graceMs = opts?.graceMs ?? DEFAULT_GRACE_MS;
    const waitExitMs = opts?.waitExitMs ?? DEFAULT_WAIT_EXIT_MS;
    const awaitExit = opts?.awaitExit !== false;

    this.killInFlight = (async () => {
      try {
        await escalateKill(child, graceMs);
      } finally {
        if (this.child === child) this.child = null;
        if (awaitExit) {
          await waitForExit(child, waitExitMs);
          // Final force if still hanging
          if (child.exitCode === null && child.signalCode == null) {
            forceKill(child);
            await waitForExit(child, 1000);
          }
        }
      }
    })();

    try {
      await this.killInFlight;
    } finally {
      this.killInFlight = null;
    }
  }

  /** Write one NDJSON line to the current child's stdin. */
  writeLine(line: string): void {
    if (!this.isWritable()) {
      throw new Error('agy child stdin not writable');
    }
    try {
      this.child!.stdin!.write(line.endsWith('\n') ? line : line + '\n');
    } catch {
      // safe swallow
    }
  }
}

/**
 * Soft → hard kill sequence (cross-platform).
 * Windows: child.kill('SIGINT') may be no-op; we still try SIGTERM then force.
 */
export async function escalateKill(
  child: ChildProcess,
  graceMs = DEFAULT_GRACE_MS,
): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return;

  trySignal(child, 'SIGINT');
  const exited = await waitForExit(child, graceMs);
  if (exited) return;

  trySignal(child, 'SIGTERM');
  const exited2 = await waitForExit(child, Math.min(1000, graceMs));
  if (exited2) return;

  forceKill(child);
}

function trySignal(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.exitCode == null && child.signalCode == null) {
      child.kill(signal);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Force-terminate. On Windows, prefer taskkill /T /F when pid is known;
 * fall back to child.kill('SIGKILL') / kill(undefined).
 */
export function forceKill(child: ChildProcess): void {
  if (child.exitCode != null || child.signalCode != null) return;

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

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(ok);
    };
    const onExit = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
    };
    child.once('exit', onExit);
  });
}

/** Standalone kill helper for callers that only hold a ChildProcess. */
export async function killAgyChild(
  child: ChildProcess | null | undefined,
  opts?: { graceMs?: number; waitExitMs?: number },
): Promise<void> {
  if (!child) return;
  await escalateKill(child, opts?.graceMs ?? DEFAULT_GRACE_MS);
  await waitForExit(child, opts?.waitExitMs ?? DEFAULT_WAIT_EXIT_MS);
  if (child.exitCode == null && child.signalCode == null) {
    forceKill(child);
    await waitForExit(child, 1000);
  }
}
