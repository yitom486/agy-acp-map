#!/usr/bin/env bun
/**
 * LIVE end-to-end MCP test (needs real logged-in `agy` + spends ONE model turn):
 * 1. writes a zero-dependency `add(a,b)` MCP stdio server to the temp dir,
 * 2. session/new with mcpServers=[that server] THROUGH THE BRIDGE (dist/bin.js),
 * 3. asserts the server is visible in real `agy mcp list`,
 * 4. prompts the model to call add(23,45); asserts the tool ran + answer 68,
 * 5. session/delete (refcount cleanup) + asserts `agy mcp list` is clean again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSmokeHarness } from './helpers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_BIN = path.resolve(__dirname, '..', '..', 'dist', 'bin.js');
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe';
const AGY = process.env.AGY_BIN || process.env.AGY_BIN_PATH || 'agy';
const NAME = `smoke-add-${process.pid}`;
const CWD = process.env.SMOKE_CWD || path.resolve(__dirname, '../..');

const SERVER_SRC = `const fs = require('fs');
const LOG = process.env.SMOKE_MCP_LOG || 'NUL';
function tlog(m) { try { fs.appendFileSync(LOG, m + '\\n'); } catch {} }
const KNOWN = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(line);
  }
});
function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
}
function handle(line) {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  tlog('got: ' + (m.method || ('resp:' + m.id)));
  if (m.method === 'initialize') {
    const v = KNOWN.includes(m.params && m.params.protocolVersion) ? m.params.protocolVersion : '2024-11-05';
    reply(m.id, { protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'smoke-add', version: '0.0.1' } });
  } else if (m.method === 'tools/list') {
    reply(m.id, { tools: [{ name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } }] });
  } else if (m.method === 'tools/call') {
    const args = (m.params && m.params.arguments) || {};
    reply(m.id, { content: [{ type: 'text', text: String(Number(args.a) + Number(args.b)) }] });
  } else if (m.id !== undefined && m.id !== null) {
    reply(m.id, {}); // ping / roots / anything else: never hang the client
  }
}
`;

function runAgy(args: string[]): Promise<{ status: number; out: string }> {
  return new Promise((resolve) => {
    execFile(AGY, args, { timeout: 30000, windowsHide: true }, (err: any, stdout: any, stderr: any) => {
      resolve({ status: err?.code ?? (err ? 1 : 0), out: String(stdout ?? '') + String(stderr ?? '') });
    });
  });
}

const serverFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-add-')), 'add-server.cjs');
fs.writeFileSync(serverFile, SERVER_SRC);
const toyLog = path.join(path.dirname(serverFile), 'toy.log');
console.log('[smoke-mcp-e2e] server file:', serverFile);

const harness = createSmokeHarness({ tag: 'smoke-mcp-e2e', serverPath: DIST_BIN, cwd: CWD, env: { SMOKE_MCP_LOG: toyLog } });
const { send, waitIdle, kill, agentTexts, events } = harness;

try {
  const init: any = await send('initialize', {
    protocolVersion: 1,
    capabilities: {},
    info: { name: 'smoke-mcp-e2e', title: 'Smoke', version: '0.0.1' },
  });
  console.log('[smoke-mcp-e2e] bridge:', init.agentInfo?.version ?? init.info?.version);

  const ns: any = await send('session/new', {
    cwd: CWD,
    // NOTE: ACP spec REQUIRES `env` on stdio entries (zMcpServerStdio has no
    // optional fields); the SDK silently drops elements missing it, so the
    // bridge would see [] and register nothing. Always send full shape.
    mcpServers: [{ name: NAME, command: NODE_EXE, args: [serverFile], env: [] }],
  });
  const sessionId = ns.sessionId;
  if (!sessionId) throw new Error('no sessionId from session/new');
  console.log('[smoke-mcp-e2e] session:', sessionId);

  const listed = await runAgy(['mcp', 'list']);
  if (!listed.out.includes(NAME)) throw new Error(`server missing from agy mcp list:\n${listed.out.slice(-500)}`);
  console.log('[smoke-mcp-e2e] ok: registered + visible in agy mcp list');

  await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Call the add tool with a=23 and b=45. Reply with ONLY the resulting number, nothing else.' }],
  });
  await waitIdle(300000, sessionId);

  const blob = JSON.stringify(events);
  const toolRan = /tool_call/i.test(blob) && blob.toLowerCase().includes('add');
  const text = agentTexts.join('\n');
  console.log('[smoke-mcp-e2e] agent text tail:', JSON.stringify(text.slice(-200)));
  if (!toolRan) throw new Error('no add tool_call observed in session updates');
  console.log('[smoke-mcp-e2e] ok: add tool was invoked');
  if (!/\b68\b/.test(text)) throw new Error(`expected 68 in agent text, got: ${JSON.stringify(text.slice(-300))}`);
  console.log('[smoke-mcp-e2e] ok: model answered 68 (23+45 via live MCP tool)');

  await send('session/delete', { sessionId });
  const listed2 = await runAgy(['mcp', 'list']);
  if (listed2.out.includes(NAME)) throw new Error('server still listed after session/delete');
  console.log('[smoke-mcp-e2e] ok: removed after delete (config clean)');
  try {
    console.log('[smoke-mcp-e2e] toy server saw:\n' + fs.readFileSync(toyLog, 'utf8'));
  } catch { /* toy never launched (no tool use path) */ }
  console.log('[smoke-mcp-e2e] PASS');
} finally {
  try {
    kill();
  } catch { /* ignore */ }
  try {
    fs.rmSync(path.dirname(serverFile), { recursive: true, force: true });
  } catch { /* ignore */ }
}
