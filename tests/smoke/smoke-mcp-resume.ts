#!/usr/bin/env bun
/**
 * LIVE resume-path MCP test (needs real `agy`, NO model turn, NO login):
 * session/new with a server -> wipe it out from under the session
 * (`agy mcp remove`, simulating a lost config / fresh daemon) ->
 * session/resume WITH the server -> assert `agy mcp list` shows it again
 * (resume re-registers) -> session/delete -> assert config clean.
 * Proves every reattach path (auto-resume on agent switch included)
 * carries MCP, not just session/new.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSmokeHarness } from './helpers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_BIN = path.resolve(__dirname, '..', '..', 'dist', 'bin.js');
const AGY = process.env.AGY_BIN || process.env.AGY_BIN_PATH || 'agy';
const NAME = `smoke-rs-${process.pid}`;
const CWD = path.resolve(__dirname, '../..');
const SERVER = { name: NAME, command: 'C:\\Windows\\System32\\whoami.exe', args: ['/uptime'], env: [] };

function runAgy(args: string[]): Promise<{ status: number; out: string }> {
  return new Promise((resolve) => {
    execFile(AGY, args, { timeout: 30000, windowsHide: true }, (err: any, stdout: any, stderr: any) => {
      resolve({ status: err?.code ?? (err ? 1 : 0), out: String(stdout ?? '') + String(stderr ?? '') });
    });
  });
}

const h = createSmokeHarness({ tag: 'smoke-mcp-resume', serverPath: DIST_BIN, cwd: CWD });
try {
  await h.send('initialize', { protocolVersion: 1, capabilities: {}, info: { name: 'smoke-mcp-resume', version: '0.0.1' } });
  const ns: any = await h.send('session/new', { cwd: CWD, mcpServers: [SERVER] });
  const sessionId = ns.sessionId;
  if (!sessionId) throw new Error('no sessionId');
  console.log('[smoke-mcp-resume] session:', sessionId);

  let l = await runAgy(['mcp', 'list']);
  if (!l.out.includes(NAME)) throw new Error('new did not register');
  console.log('[smoke-mcp-resume] ok: new registered');

  // Simulate a wiped config (fresh daemon, cleaned file, whatever).
  const rm = await runAgy(['mcp', 'remove', NAME]);
  if (rm.status !== 0) throw new Error('setup wipe failed: ' + rm.out.slice(-200));
  l = await runAgy(['mcp', 'list']);
  if (l.out.includes(NAME)) throw new Error('setup wipe did not take');
  console.log('[smoke-mcp-resume] ok: config wiped underneath');

  const rs: any = await h.send('session/resume', { sessionId, cwd: CWD, mcpServers: [SERVER] });
  if (!rs) throw new Error('empty resume response');
  l = await runAgy(['mcp', 'list']);
  if (!l.out.includes(NAME)) throw new Error('resume did NOT re-register the server');
  console.log('[smoke-mcp-resume] ok: resume re-registered (visible in list)');

  await h.send('session/delete', { sessionId });
  l = await runAgy(['mcp', 'list']);
  if (l.out.includes(NAME)) throw new Error('server still listed after delete');
  console.log('[smoke-mcp-resume] ok: removed after delete (config clean)');
  console.log('[smoke-mcp-resume] PASS');
} finally {
  h.kill();
}
