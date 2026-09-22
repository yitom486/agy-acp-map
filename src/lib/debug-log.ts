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

export function installFileLogging(): string | null {
  try {
    process.on('uncaughtException', (err) => {
      debugLog(`FATAL uncaughtException: ${err?.stack || err}`);
    });
    process.on('unhandledRejection', (reason) => {
      debugLog(`FATAL unhandledRejection: ${reason instanceof Error ? reason.stack : reason}`);
    });
    process.stdin.on('end', () => debugLog('stdin END (parent closed pipe)'));
    process.stdin.on('close', () => debugLog('stdin CLOSE'));
  } catch {
    // ignore
  }
  return logPath;
}
