#!/usr/bin/env bun
/**
 * Live smoke for v0.3 launch flags + --conversation respawn.
 *
 * 1. session/new with a flash-like model (from `agy models` if available)
 * 2. prompt "Reply with exactly: flagok"
 * 3. cancel/kill child; second prompt asks for the exact word → expect flagok
 * 4. optional sandbox=true no-shell prompt
 * 5. json-schema session/new → verify spawn includes --json-schema + idle SUCCESS
 */
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.ts');
const CWD = path.join(__dirname, '..', 'smoke-workdir-flags');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 180000);

function ensurePath() {
  const extra = '/home/box/.local/bin';
  const p = process.env.PATH || '';
  if (!p.split(path.delimiter).includes(extra)) {
    process.env.PATH = `${extra}${path.delimiter}${p}`;
  }
}
ensurePath();
fs.mkdirSync(CWD, { recursive: true });

function pickModel() {
  try {
    const out = execSync('agy models', {
      encoding: 'utf8',
      timeout: 30000,
      env: process.env,
    });
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const ids = lines
      .map((l) => l.split(/\s+/)[0])
      .filter((id) => id && !id.startsWith('Fetching'));
    const flash = ids.find((id) => /flash/i.test(id));
    return flash || ids[0] || null;
  } catch (err) {
    console.error('[smoke-flags] agy models failed:', err.message);
    return null;
  }
}

const MODEL = process.env.SMOKE_MODEL || pickModel();
console.log('[smoke-flags] model pin:', MODEL || '(none — omit --model)');

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
  cwd: __dirname,
});

let nextId = 1;
/** @type {Map<number, {resolve: Function, reject: Function}>} */
const pending = new Map();
const serverLog = [];
const agentTexts = [];
let conversationId = null;
let lastIdle = null;
/** @type {((u: object) => void) | null} */
let onIdle = null;

function log(tag, obj) {
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
  console.log(`[smoke-flags:${tag}] ${line}`);
}

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  log('→', msg);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  log('notify→', { method, params });
}

function waitIdle(timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (lastIdle && lastIdle.pending) {
      lastIdle.pending = false;
      resolve(lastIdle);
      return;
    }
    const t = setTimeout(() => {
      onIdle = null;
      reject(new Error(`idle timeout ${timeoutMs}ms`));
    }, timeoutMs);
    onIdle = (u) => {
      clearTimeout(t);
      onIdle = null;
      resolve(u);
    };
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
  if (msg.method === 'session/update') {
    const u = msg.params?.update;
    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      agentTexts.push(u.content.text);
    }
    if (u?.sessionUpdate === 'state_update' && u.state === 'idle') {
      lastIdle = { ...u, pending: true, at: Date.now() };
      if (onIdle) {
        lastIdle.pending = false;
        onIdle(u);
      }
    }
    log('notify', { sessionUpdate: u?.sessionUpdate, state: u?.state, stopReason: u?.stopReason });
  }
});

child.stderr.on('data', (buf) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue;
    serverLog.push(line);
    console.error(`[server] ${line}`);
    // Capture conversation id from spawn log if present
    const m = line.match(/conversation=([^\s]+)/);
    if (m) conversationId = m[1];
  }
});

function spawnArgsInclude(flag) {
  return serverLog.some((l) => l.includes('[agy-acp] spawn') && l.includes(flag));
}

function collectConversationFromList(listResult) {
  const s = listResult?.sessions?.[0];
  return s?.conversationId || s?._meta?.conversationId || null;
}

const results = {
  turn1: false,
  conversationPersisted: false,
  respawnConversationFlag: false,
  turn2Context: false,
  sandbox: null,
  jsonSchema: null,
};

async function runTurn1(sessionId) {
  agentTexts.length = 0;
  lastIdle = null;
  await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly: flagok' }],
  });
  const idle = await waitIdle();
  const text = agentTexts.join('');
  results.turn1 = /flagok/i.test(text) && idle.stopReason !== 'cancelled';
  log('check', `turn1 text=${JSON.stringify(text.slice(0, 200))} idle=${idle.stopReason} pass=${results.turn1}`);
}

async function cancelAndRespawn(sessionId) {
  // Force kill child via cancel so next prompt respawns
  notify('session/cancel', { sessionId });
  // Wait briefly for child exit
  await new Promise((r) => setTimeout(r, 2500));

  const listed = await send('session/list', { cwd: CWD });
  const cid = collectConversationFromList(listed) || conversationId;
  if (cid) {
    conversationId = cid;
    results.conversationPersisted = true;
  }
  log('check', `conversationId=${cid}`);

  // Clear idle latch from cancel if any
  lastIdle = null;
  agentTexts.length = 0;

  const beforeSpawns = serverLog.filter((l) => l.includes('[agy-acp] spawn')).length;
  await send('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text: 'What exact word did I ask you to reply with? Answer with just that word.',
      },
    ],
  });
  const idle = await waitIdle();
  const text = agentTexts.join('');
  results.turn2Context = /flagok/i.test(text);
  const afterSpawns = serverLog.filter((l) => l.includes('[agy-acp] spawn'));
  const lastSpawn = afterSpawns[afterSpawns.length - 1] || '';
  results.respawnConversationFlag =
    afterSpawns.length > beforeSpawns && lastSpawn.includes('--conversation');
  log(
    'check',
    `turn2 text=${JSON.stringify(text.slice(0, 200))} respawnConv=${results.respawnConversationFlag} context=${results.turn2Context}`,
  );
}

async function runSandboxSmoke() {
  try {
    const { sessionId } = await send('session/new', {
      cwd: CWD,
      sandbox: true,
      ...(MODEL ? { model: MODEL } : {}),
    });
    agentTexts.length = 0;
    lastIdle = null;
    await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly: sandboxok (no tools needed)' }],
    });
    const idle = await waitIdle(120000);
    const text = agentTexts.join('');
    const spawned = spawnArgsInclude('--sandbox');
    results.sandbox = spawned && /sandboxok/i.test(text) && idle.state === 'idle';
    await send('session/close', { sessionId });
    log('check', `sandbox pass=${results.sandbox} spawned=${spawned}`);
  } catch (err) {
    results.sandbox = false;
    log('sandbox-error', err.message || err);
  }
}

async function runJsonSchemaSmoke() {
  try {
    const schema = {
      type: 'object',
      properties: { word: { type: 'string' } },
      required: ['word'],
    };
    const { sessionId } = await send('session/new', {
      cwd: CWD,
      jsonSchema: schema,
      ...(MODEL ? { model: MODEL } : {}),
    });
    agentTexts.length = 0;
    lastIdle = null;
    await send('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Return a JSON object with property word set to schemaok.',
        },
      ],
    });
    const idle = await waitIdle(120000);
    const spawned = spawnArgsInclude('--json-schema');
    results.jsonSchema = spawned && idle.state === 'idle' && idle.stopReason === 'end_turn';
    await send('session/close', { sessionId });
    log('check', `jsonSchema pass=${results.jsonSchema} spawned=${spawned}`);
  } catch (err) {
    results.jsonSchema = false;
    log('jsonSchema-error', err.message || err);
  }
}

let finished = false;
function finish(ok) {
  if (finished) return;
  finished = true;
  console.log('---');
  console.log('RESULTS', JSON.stringify(results, null, 2));
  console.log(`SMOKE_FLAGS ${ok ? 'PASS' : 'FAIL'}`);
  try {
    child.stdin.end();
  } catch {
    /* ignore */
  }
  child.kill('SIGTERM');
  setTimeout(() => process.exit(ok ? 0 : 1), 400).unref?.();
}

const timer = setTimeout(() => {
  log('timeout', `overall ${TIMEOUT_MS}ms`);
  finish(false);
}, TIMEOUT_MS + 60000);

try {
  const init = await send('initialize', {
    protocolVersion: 2,
    capabilities: {},
    info: { name: 'agy-acp-smoke-flags', version: '0.0.1' },
  });
  if (init.info?.version !== '0.4.0') {
    console.warn('[smoke-flags] warn: expected info.version 0.4.0 got', init.info?.version);
  }
  if (init.bridgeCapabilities?.dynamicConfig !== 'restart') {
    throw new Error('bridgeCapabilities.dynamicConfig expected restart');
  }
  if (init.bridgeCapabilities?.resume !== true) {
    throw new Error('bridgeCapabilities.resume expected true');
  }

  const newParams = { cwd: CWD };
  if (MODEL) newParams.model = MODEL;
  const newRes = await send('session/new', newParams);
  const sessionId = newRes.sessionId;
  if (!sessionId) throw new Error('no sessionId');

  // Optional: set_config_option smoke (idle)
  if (MODEL) {
    const cfg = await send('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: MODEL,
    });
    log('set_config', cfg);
  }

  await runTurn1(sessionId);

  // Persist conversation via list after turn1
  const listed1 = await send('session/list', { cwd: CWD });
  const cid1 = collectConversationFromList(listed1);
  if (cid1) {
    conversationId = cid1;
    results.conversationPersisted = true;
  }

  await cancelAndRespawn(sessionId);
  await send('session/close', { sessionId });

  await runSandboxSmoke();
  await runJsonSchemaSmoke();

  clearTimeout(timer);
  const ok =
    results.turn1 &&
    results.conversationPersisted &&
    results.respawnConversationFlag &&
    results.turn2Context &&
    results.sandbox !== false &&
    results.jsonSchema !== false;
  // sandbox/jsonSchema null means skipped-with-error path set false; treat null as skip fail
  const okStrict =
    results.turn1 &&
    results.conversationPersisted &&
    results.respawnConversationFlag &&
    results.turn2Context &&
    results.sandbox === true &&
    results.jsonSchema === true;
  finish(okStrict);
} catch (err) {
  console.error('[smoke-flags] error', err);
  clearTimeout(timer);
  finish(false);
}
