/**
 * File logging for headless diagnosis (Zed hides stderr).
 * Path: AGY_ACP_LOG or %TEMP%/agy-acp.log. Appends, truncates past ~1MB.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function resolveLogPath(): string {
  const override = process.env.AGY_ACP_LOG;
  if (override && override !== 'undefined' && override !== 'null') return override;
  return path.join(os.tmpdir(), 'agy-acp.log');
}

let logPath: string | null = null;
try {
  logPath = resolveLogPath();
} catch {
  logPath = null;
}

function writeLine(line: string): void {
  if (!logPath) return;
  try {
    let truncate = false;
    try {
      const st = fs.statSync(logPath);
      if (st.size > 1024 * 1024) truncate = true;
    } catch {
      // missing file: just create
    }
    fs.appendFileSync(logPath, line + '\n', 'utf8');
    if (truncate) {
      try {
        const text = fs.readFileSync(logPath, 'utf8');
        fs.writeFileSync(logPath, text.slice(-512 * 1024), 'utf8');
      } catch {
        // ignore rotation failure
      }
    }
  } catch {
    // logging must never break the bridge
  }
}

export function debugLog(msg: string): void {
  writeLine(`${new Date().toISOString()} pid=${process.pid} ${msg}`);
}

export function isAgyDebug(): boolean {
  return process.env.AGY_ACP_DEBUG === '1' || process.env.DEBUG === '1' || process.env.DEBUG === 'true';
}

/**
 * Routine operational/warmup trace logging:
 * - Always recorded in headless disk log (%TEMP%/agy-acp.log).
 * - Silent on stderr by default (following codex-acp stdio silence invariants).
 * - Only mirrored to stderr when AGY_ACP_DEBUG=1 or DEBUG=1.
 */
export function traceLog(msg: string, ...rest: unknown[]): void {
  const line = rest.length
    ? `${msg} ${rest.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ')}`
    : msg;
  debugLog(line);
  if (isAgyDebug()) {
    process.stderr.write(`[agy-acp] ${line}\n`);
  }
}

/**
 * True failure/error logging:
 * - Always recorded in disk log.
 * - Always surfaced to stderr so operators and supervising harnesses know what broke.
 */
export function errorLog(msg: string, ...rest: unknown[]): void {
  const line = rest.length
    ? `${msg} ${rest.map((r) => (r instanceof Error ? r.stack || r.message : typeof r === 'string' ? r : JSON.stringify(r))).join(' ')}`
    : msg;
  debugLog(`ERROR: ${line}`);
  process.stderr.write(`[agy-acp:error] ${line}\n`);
}

export function warnLog(msg: string, ...rest: unknown[]): void {
  const line = rest.length
    ? `${msg} ${rest.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ')}`
    : msg;
  debugLog(`WARN: ${line}`);
  if (isAgyDebug()) {
    process.stderr.write(`[agy-acp:warn] ${line}\n`);
  }
}

export function installFileLogging(): string | null {
  try {
    process.on('uncaughtException', (err) => {
      debugLog(`FATAL uncaughtException: ${err?.stack || err}`);
      errorLog(`FATAL uncaughtException: ${err?.stack || err}`);
    });
    process.on('unhandledRejection', (reason) => {
      const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
      debugLog(`FATAL unhandledRejection: ${msg}`);
      errorLog(`FATAL unhandledRejection: ${msg}`);
    });
    process.stdin.on('end', () => debugLog('stdin END (parent closed pipe)'));
    process.stdin.on('close', () => debugLog('stdin CLOSE'));
  } catch {
    // ignore
  }
  return logPath;
}
