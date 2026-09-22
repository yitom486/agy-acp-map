#!/usr/bin/env bun
/**
 * Official ACP SDK Server Entry Point (Dual v1 / v2 protocol support).
 * Connects standard Stdio to the AgyAcpService via @agentclientprotocol/sdk.
 */
import { hideConsoleWindow } from './lib/win32-console.ts';

// Immediately hide console window on Windows to prevent black box on connection
hideConsoleWindow();

import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { createDualAcpApp, AgyAcpService } from './agent-sdk.ts';
import { debugLog, installFileLogging } from './lib/debug-log.ts';

const logPath = installFileLogging();
debugLog(`START argv=${JSON.stringify(process.argv.slice(1))} cwd=${process.cwd()} bun=${(process as any).versions?.bun || 'no'} node=${process.version} log=${logPath}`);

const service = new AgyAcpService();
const app = createDualAcpApp(service);

// NOTE: no stdin/stdout tee here on purpose: the original direct plumbing
// stays byte-identical to the known-good builds; adapter-level logging
// (v1/v2 adapter) records what matters.
const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

process.stderr.write('[agy-acp-sdk] Starting official @agentclientprotocol/sdk stdio server...\n');

// No orphans: terminating the bridge must also terminate supervised agy
// children (warmup/turn processes), otherwise they pin the install directory
// and block on-demand updates on Windows (EBUSY on running exes).
let shuttingDown = false;
async function shutdown(code: number): Promise<never> {
  if (shuttingDown) process.exit(code);
  shuttingDown = true;
  debugLog(`shutdown code=${code}: killing supervised agy children`);
  try {
    await service.shutdown();
  } catch (err) {
    debugLog(`shutdown kill error: ${(err as Error)?.message}`);
  }
  debugLog('shutdown complete');
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
// Parent gone => stdio dead => clean up children and exit (this, not the
// line below connect(), is the normal termination path).
process.stdin.on('end', () => void shutdown(0));
process.stdin.on('close', () => void shutdown(0));

await app.connect(stream);
debugLog('CONNECT-SETUP-DONE (serving; exit only via stdin close or signal)');
// NOTE: AgentApp.connect() only wires the transport and returns immediately;
// it does NOT run until the stream closes. Shutting down here would kill the
// server on every boot. Termination happens via stdin end/close (parent gone)
// or signals above — never unconditionally below connect().
