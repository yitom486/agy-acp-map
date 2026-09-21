/**
 * Black-box console-flash test (Windows-only).
 *
 * Simulates a GUI parent like Zed: the winexe watchdog has no console of its
 * own, spawns a child the naive way (no CREATE_NO_WINDOW) and reports whether
 * any NEW visible console window (conhost) appeared. This is the closest we
 * can get to "did the user see a black box?" from inside an automated test.
 *
 * Scenarios:
 *   1. positive control: naive `cmd.exe` must flash (else this environment
 *      cannot surface consoles and the rest is skipped, not failed);
 *   2. shimmed `cmd.exe` via dist/agy-headless.exe must NOT flash;
 *   3. full bridge chain (node dist/bin.js + initialize/new + warmup) under a
 *      naive parent: only the bridge's own entry console may appear;
 *   4. same chain under a well-behaved parent (--no-window): zero windows;
 *   5. fallback chain (AGY_DISABLE_HEADLESS_LAUNCHER=1): informational, plus
 *      asserts the bridge logs the direct-spawn warning.
 *
 * Skips gracefully off-Windows or without csc.exe. Slow (~30s) by design:
 * it observes real windows, it does not mock them.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const ROOT = path.resolve(import.meta.dir, '..');
const SHIM = path.join(ROOT, 'dist', 'agy-headless.exe');
const BRIDGE = path.join(ROOT, 'dist', 'bin.js');
const WATCHDOG_CS = path.join(ROOT, 'tests', 'helpers', 'console-flash-watchdog.cs');

interface FlashVerdict {
  /** Attributed to the watchdog's own tree (parent-chain walk). */
  newWindows: { hwnd: number; pid: number; title: string; process: string }[];
  newWindowsAmbient: { hwnd: number; pid: number; title: string; process: string }[];
  /** Attributed console hosts born inside the window. */
  conhostDelta: number[];
  conhostDeltaAmbient: number[];
  childExit: number;
  error?: string;
}

function findCsc(): string | null {
  const windir = process.env.windir || process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    path.join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(windir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

let watchdogBin: string | null = null;
let watchdogError = '';

function ensureWatchdog(): string | null {
  if (watchdogBin || watchdogError) return watchdogBin;
  if (!WIN) {
    watchdogError = 'non-Windows platform';
    return null;
  }
  const csc = findCsc();
  if (!csc) {
    watchdogError = 'csc.exe not found';
    return null;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flash-watchdog-'));
  const out = path.join(dir, 'flash-watchdog.exe');
  const r = spawnSync(csc, ['/target:winexe', '/optimize+', '/nologo', `/out:${out}`, WATCHDOG_CS], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0 || !fs.existsSync(out)) {
    const detail = ((r.stdout || '') + '\n' + (r.stderr || '')).toString().slice(0, 500);
    watchdogError = `csc build failed (status=${r.status}): ${detail || r.error || 'no output'}`;
    return null;
  }
  watchdogBin = out;
  return out;
}

function runWatch(args: string[], opts?: { env?: NodeJS.ProcessEnv }): FlashVerdict {
  const wd = ensureWatchdog();
  if (!wd) throw new Error(`watchdog unavailable: ${watchdogError}`);
  const r = spawnSync(wd, args, {
    encoding: 'utf8',
    env: opts?.env ?? process.env,
    windowsHide: true,
    timeout: 90000,
  });
  if (r.error) throw r.error;
  const line = (r.stdout || '').trim().split('\n').pop() || '{}';
  return JSON.parse(line) as FlashVerdict;
}

function flashCount(v: FlashVerdict): number {
  return v.newWindows.length + v.conhostDelta.length;
}

function fmt(v: FlashVerdict): string {
  const wins = v.newWindows.map((w) => `${w.process || '?'}#${w.pid} ${JSON.stringify(w.title)}`).join('; ');
  return (
    `ours(windows=${v.newWindows.length}[${wins}] conhost=${v.conhostDelta.length}) ` +
    `ambient(windows=${(v.newWindowsAmbient || []).length} conhost=${(v.conhostDeltaAmbient || []).length}) ` +
    `exit=${v.childExit}`
  );
}

/**
 * Kill leftover warmup children by PID parsed from the bridge stderr log.
 * No powershell/taskkill involved, so cleanup itself cannot flash.
 */
function killLoggedPids(stderrFile: string): void {
  let text = '';
  try {
    text = fs.readFileSync(stderrFile, 'utf8');
  } catch {
    return;
  }
  const pids = new Set<number>();
  for (const m of text.matchAll(/subprocess started with PID:\s*(\d+)/g)) {
    const pid = Number(m[1]);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  for (const pid of pids) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
}

// `pause` holds the console without spawning grandchildren (timeout/ping
// would fork their own console host and muddy attribution). stdin is a pipe
// the watchdog holds open, so `pause` waits until killed.
const LINGER = ['/c', 'echo hi & pause >nul'];
let visibleFlashPossible: boolean | null = null;
// conhost churn is observable even when Windows Terminal swallows the visible
// window (tabs instead of ConsoleWindowClass). Any churn in the control means
// the shim's zero-churn assertions are meaningful on this machine.
let churnObservable: boolean | null = null;

describe('console flash (Zed-like GUI parent)', () => {
  test('positive control: naive CUI spawn flashes', () => {
    if (!WIN) {
      console.log('[flash] skip: non-Windows');
      return;
    }
    if (!ensureWatchdog()) {
      console.log(`[flash] skip: ${watchdogError}`);
      return;
    }
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const v = runWatch(['--observe', '3000', '--', cmd, ...LINGER]);
    console.log(`[flash] control naive cmd: ${fmt(v)}`);
    visibleFlashPossible = v.newWindows.length > 0;
    churnObservable = flashCount(v) > 0;
    if (!churnObservable) {
      console.log('[flash] SKIP-REST: no console activity attributable here; shim assertions would be vacuous.');
      return;
    }
    // The naive child must own a console host: the necessary condition for a
    // visible flash on classic-conhost machines.
    expect(v.conhostDelta.length).toBeGreaterThan(0);
  });

  test('shimmed CUI spawn does not flash', () => {
    if (!WIN || !ensureWatchdog()) return;
    if (!fs.existsSync(SHIM)) throw new Error(`missing shim: ${SHIM} (run bun run build:headless)`);
    if (!churnObservable && visibleFlashPossible === false) {
      console.log('[flash] skip: control shows no console activity in this environment');
      return;
    }
    const cmd = 'C:\\Windows\\System32\\cmd.exe';
    const v = runWatch(['--observe', '3000', '--', SHIM, cmd, ...LINGER]);
    console.log(`[flash] shimmed cmd: ${fmt(v)}`);
    // No VISIBLE window: CREATE_NO_WINDOW gives the child a hidden console
    // (an invisible conhost may legitimately remain — stdio needs it).
    // stdio integrity itself is covered by the shim quote/passthrough checks.
    expect(v.newWindows).toEqual([]);
  });

  function chainFiles(tag: string): {
    dir: string;
    stdinFile: string;
    stderrFile: string;
    fakeAgy: string;
    env: NodeJS.ProcessEnv;
  } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `flash-chain-${tag}-`));
    // A fake agy.exe (cmd.exe copy): basename match routes it through the shim,
    // and it is harmless + killable by exact path afterwards.
    const fakeDir = path.join(dir, 'fakebin');
    fs.mkdirSync(fakeDir, { recursive: true });
    const fakeAgy = path.join(fakeDir, 'agy.exe');
    fs.copyFileSync('C:\\Windows\\System32\\cmd.exe', fakeAgy);
    const storeDir = path.join(dir, 'store');
    fs.mkdirSync(storeDir, { recursive: true });
    const lines = [
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: 1, capabilities: {}, info: { name: 'flash', version: '0' } },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: dir, mcpServers: [] },
      }),
    ].join('\n') + '\n';
    const stdinFile = path.join(dir, 'stdin.ndjson');
    fs.writeFileSync(stdinFile, lines);
    const stderrFile = path.join(dir, 'bridge-stderr.log');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      AGY_BIN: fakeAgy,
      AGY_HEADLESS_LAUNCHER: SHIM,
      AGY_ACP_SESSION_STORE: path.join(storeDir, 'sessions.json'),
      AGY_ACP_HISTORY_DIR: path.join(storeDir, 'history'),
    };
    return { dir, stdinFile, stderrFile, fakeAgy, env };
  }

  test('bridge chain, naive parent: only the entry console; warmup uses shim', () => {
    if (!WIN || !ensureWatchdog()) return;
    const t = chainFiles('naive');
    try {
      const v = runWatch(
        ['--observe', '5000', '--stdin', t.stdinFile, '--stderr', t.stderrFile, '--', process.execPath, BRIDGE],
        { env: t.env },
      );
      const stderr = fs.existsSync(t.stderrFile) ? fs.readFileSync(t.stderrFile, 'utf8') : '';
      console.log(`[flash] bridge naive: ${fmt(v)}`);
      console.log(`[flash] warmup logged: ${stderr.includes('warmup: pre-spawning')}`);
      expect(stderr).toContain('warmup: pre-spawning');
      expect(stderr).toContain('CREATE_NO_WINDOW');
      // The bridge entry (node, CUI) legitimately owns one console under a
      // naive parent; agy itself (warmup) must not add any.
      if (visibleFlashPossible === false) {
        expect(v.newWindows.length).toBeLessThanOrEqual(1);
      } else {
        expect(v.newWindows.length).toBe(1);
      }
    } finally {
      killLoggedPids(t.stderrFile);
    }
  });

  test('bridge chain, well-behaved parent: zero windows', () => {
    if (!WIN || !ensureWatchdog()) return;
    const t = chainFiles('nowin');
    try {
      const v = runWatch(
        ['--no-window', '--observe', '5000', '--stdin', t.stdinFile, '--stderr', t.stderrFile, '--', process.execPath, BRIDGE],
        { env: t.env },
      );
      const stderr = fs.existsSync(t.stderrFile) ? fs.readFileSync(t.stderrFile, 'utf8') : '';
      console.log(`[flash] bridge well-behaved: ${fmt(v)}`);
      expect(stderr).toContain('warmup: pre-spawning');
      expect(stderr).toContain('CREATE_NO_WINDOW');
      expect(v.newWindows).toEqual([]);
    } finally {
      killLoggedPids(t.stderrFile);
    }
  });

  test('bridge chain, shim disabled: direct spawn still covered, warning logged', () => {
    if (!WIN || !ensureWatchdog()) return;
    const t = chainFiles('direct');
    t.env.AGY_DISABLE_HEADLESS_LAUNCHER = '1';
    try {
      const v = runWatch(
        ['--no-window', '--observe', '5000', '--stdin', t.stdinFile, '--stderr', t.stderrFile, '--', process.execPath, BRIDGE],
        { env: t.env },
      );
      const stderr = fs.existsSync(t.stderrFile) ? fs.readFileSync(t.stderrFile, 'utf8') : '';
      console.log(`[flash] bridge direct-fallback: ${fmt(v)}`);
      expect(stderr).toContain('AGY_DISABLE_HEADLESS_LAUNCHER');
      // windowsHide:true carries CREATE_NO_WINDOW even on the direct path;
      // report the counts, require no MORE than the entry console.
      expect(v.newWindows.length).toBeLessThanOrEqual(1);
    } finally {
      killLoggedPids(t.stderrFile);
    }
  });
});
