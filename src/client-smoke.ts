#!/usr/bin/env bun
/**
 * Smoke driver: spawn server.mjs, run initialize → session/new → session/prompt,
 * print updates + bridgeCapabilities, exit when idle end_turn (or timeout).
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.ts');
const CWD = process.env.SMOKE_CWD || path.join(__dirname, '..');
const PROMPT = process.env.SMOKE_PROMPT || 'Reply with exactly: pong';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000);

function ensurePath() {
  const extra = '/home/box/.local/bin';
  const p = process.env.PATH || '';
  if (!p.split(path.delimiter).includes(extra)) {
    process.env.PATH = `${extra}${path.delimiter}${p}`;
  }
}

ensurePath();

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
  cwd: __dirname,
});

let nextId = 1;
/** @type {Map<number, {method: string, resolve: Function, reject: Function}>} */
const pending = new Map();
const events = [];
let bridgeCapabilities = null;

function log(tag, obj) {
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
  console.log(`[smoke:${tag}] ${line}`);
  events.push({ tag, at: Date.now(), obj });
}

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  log('→', msg);
  return new Promise((resolve, reject) => {
    pending.set(id, { method, resolve, reject });
  });
}

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    log('bad', t.slice(0, 200));
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    log('←', msg);
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.method) {
    log('notify', msg);
    if (
      msg.method === 'session/update' &&
      msg.params?.update?.sessionUpdate === 'state_update' &&
      msg.params.update.state === 'idle'
    ) {
      finish(msg.params.update.stopReason || 'unknown');
    }
  }
});

child.stderr.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (line.trim()) console.error(`[server] ${line}`);
  }
});

let finished = false;
function finish(stopReason) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);

  const kinds = events
    .filter((e) => e.tag === 'notify' || e.tag === '←')
    .map((e) => {
      if (e.tag === '←') {
        return `response:${e.obj.result ? Object.keys(e.obj.result).join(',') : 'error'}`;
      }
      const u = e.obj.params?.update;
      return u?.sessionUpdate || e.obj.method;
    });

  const hasInit = events.some(
    (e) => e.tag === '←' && e.obj.result?.protocolVersion === 2,
  );
  const hasSession = events.some((e) => e.tag === '←' && e.obj.result?.sessionId);
  const hasMessageId = events.some((e) => e.tag === '←' && e.obj.result?.messageId);
  const hasChunk = events.some(
    (e) =>
      e.tag === 'notify' &&
      e.obj.params?.update?.sessionUpdate === 'agent_message_chunk',
  );
  const hasIdle = events.some(
    (e) =>
      e.tag === 'notify' &&
      e.obj.params?.update?.sessionUpdate === 'state_update' &&
      e.obj.params.update.state === 'idle',
  );
  const hasBridgeCaps = Boolean(bridgeCapabilities?.prompt);

  const pass = hasInit && hasSession && hasMessageId && hasChunk && hasIdle && hasBridgeCaps;
  console.log('---');
  console.log('bridgeCapabilities:', JSON.stringify(bridgeCapabilities, null, 2));
  console.log(`SMOKE ${pass ? 'PASS' : 'FAIL'} stopReason=${stopReason}`);
  console.log(
    `checks: init=${hasInit} session=${hasSession} messageId=${hasMessageId} chunk=${hasChunk} idle=${hasIdle} bridgeCaps=${hasBridgeCaps}`,
  );
  console.log(`sequence: ${kinds.join(' → ')}`);

  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  child.kill('SIGTERM');
  setTimeout(() => process.exit(pass ? 0 : 1), 300).unref?.();
}

const timer = setTimeout(() => {
  log('timeout', `no idle within ${TIMEOUT_MS}ms`);
  finish('timeout');
}, TIMEOUT_MS);

child.on('exit', (code) => {
  if (!finished) {
    log('server-exit', String(code));
    finish('server_exit');
  }
});

try {
  const init = await send('initialize', {
    protocolVersion: 2,
    capabilities: {},
    info: { name: 'agy-acp-smoke', title: 'Smoke', version: '0.0.1' },
  });
  if (init.protocolVersion !== 2) throw new Error('expected protocolVersion 2');
  bridgeCapabilities = init.bridgeCapabilities || init._meta?.bridgeCapabilities || null;
  console.log('[smoke] info.version=', init.info?.version);
  console.log('[smoke] bridgeCapabilities=', JSON.stringify(bridgeCapabilities));

  const { sessionId } = await send('session/new', { cwd: CWD });
  if (!sessionId) throw new Error('no sessionId');

  await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: PROMPT }],
  });
} catch (err) {
  console.error('[smoke] error', err);
  finish('error');
}
