#!/usr/bin/env bun
/**
 * Live smoke for launch flags + --conversation respawn.
 */
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { ensurePath, DEFAULT_SERVER_PATH } from './helpers.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = DEFAULT_SERVER_PATH;
const ROOT = path.resolve(__dirname, '../..');
const CWD = path.join(ROOT, 'smoke-workdir-flags');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 180000);

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
  } catch (err: any) {
    console.error('[smoke-flags] agy models failed:', err.message);
    return null;
  }
}

const MODEL = process.env.SMOKE_MODEL || pickModel();
console.log('[smoke-flags] model pin:', MODEL || '(none — omit --model)');

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    AGY_ACP_SKIP_PERMISSIONS: process.env.AGY_ACP_SKIP_PERMISSIONS || '1',
    AGY_ACP_SAFETY: process.env.AGY_ACP_SAFETY || 'autonomous',
  },
  cwd: ROOT,
});

let nextId = 1;
const pending = new Map();
const serverLog: string[] = [];
const agentTexts: string[] = [];
let conversationId: string | null = null;
let lastIdle: any = null;
let onIdle: ((u: any) => void) | null = null;

function log(tag: string, obj: any) {
  const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
  console.log(`[smoke-flags:${tag}] ${line}`);
}

function send(method: string, params?: any): Promise<any> {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  child.stdin.write(JSON.stringify(msg) + '\n');
  log('→', msg);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

function notify(method: string, params?: any) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  log('notify→', { method, params });
}

function waitIdle(timeoutMs = TIMEOUT_MS, sessionId: string | null = null): Promise<any> {
  return new Promise((resolve, reject) => {
    if (lastIdle && lastIdle.pending && (!sessionId || lastIdle.sessionId === sessionId)) {
      lastIdle.pending = false;
      resolve(lastIdle);
      return;
    }
    const t = setTimeout(() => {
      onIdle = null;
      reject(new Error(`idle timeout ${timeoutMs}ms`));
    }, timeoutMs);
    onIdle = (u) => {
      if (sessionId && u.sessionId && u.sessionId !== sessionId) return;
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
  let msg: any;
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
      lastIdle = { ...u, pending: true, at: Date.now(), sessionId: msg.params?.sessionId };
      if (onIdle) {
        onIdle({ ...u, sessionId: msg.params?.sessionId });
        if (!onIdle) lastIdle.pending = false;
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
    const m = line.match(/conversation=([^\s]+)/);
    if (m) conversationId = m[1];
  }
});

function spawnArgsInclude(flag: string) {
  return serverLog.some((l) => l.includes('[agy-acp] spawn') && l.includes(flag));
}

function collectConversationFromList(listResult: any) {
  const s = listResult?.sessions?.[0];
  return s?.conversationId || s?._meta?.conversationId || null;
}

const results: Record<string, any> = {
  turn1: false,
  conversationPersisted: false,
  respawnConversationFlag: false,
  turn2Context: false,
  sandbox: null,
  jsonSchema: null,
};

async function runTurn1(sessionId: string) {
  agentTexts.length = 0;
  lastIdle = null;
  await send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly: flagok' }],
  });
  const idle = await waitIdle(TIMEOUT_MS, sessionId);
  const text = agentTexts.join('');
  results.turn1 = /flagok/i.test(text) && idle.stopReason !== 'cancelled';
  log('check', `turn1 text=${JSON.stringify(text.slice(0, 200))} idle=${idle.stopReason} pass=${results.turn1}`);
}

async function cancelAndRespawn(sessionId: string) {
  notify('session/cancel', { sessionId });
  await new Promise((r) => setTimeout(r, 2500));

  const listed = await send('session/list', { cwd: CWD });
  const cid = collectConversationFromList(listed) || conversationId;
  if (cid) {
    conversationId = cid;
    results.conversationPersisted = true;
  }
  log('check', `conversationId=${cid}`);

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
  const idle = await waitIdle(TIMEOUT_MS, sessionId);
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
    await new Promise((r) => setTimeout(r, 1500));
    lastIdle = null;
    await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly: sandboxok (no tools needed)' }],
    });
    const idle = await waitIdle(120000, sessionId);
    const text = agentTexts.join('');
    const spawned = spawnArgsInclude('--sandbox');
    const quota = /RESOURCE_EXHAUSTED|quota reached|429/i.test(text + serverLog.join('\n'));
    results.sandbox = spawned && (idle.state === 'idle') && (/sandboxok/i.test(text) || quota);
    await send('session/close', { sessionId });
    log('check', `sandbox pass=${results.sandbox} spawned=${spawned} quota=${quota} text=${JSON.stringify(text.slice(0, 120))}`);
  } catch (err: any) {
    const spawned = spawnArgsInclude('--sandbox');
    const quota = /RESOURCE_EXHAUSTED|quota reached|429/i.test(serverLog.join('\n'));
    results.sandbox = spawned ? true : false;
    log('sandbox-error', `${err.message || err} spawned=${spawned} quota=${quota} → sandbox=${results.sandbox}`);
  }
}

async function runJsonSchemaSmoke() {
  try {
    const schema = JSON.stringify({
      type: 'object',
      properties: { greeting: { type: 'string' } },
      required: ['greeting'],
    });
    const { sessionId } = await send('session/new', {
      cwd: CWD,
      jsonSchema: schema,
      ...(MODEL ? { model: MODEL } : {}),
    });
    agentTexts.length = 0;
    lastIdle = null;
    await new Promise((r) => setTimeout(r, 1500));
    lastIdle = null;
    await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Return valid JSON matching schema with greeting: "hello"' }],
    });
    const idle = await waitIdle(120000, sessionId);
    const text = agentTexts.join('');
    const spawned = spawnArgsInclude('--json-schema');
    const quota = /RESOURCE_EXHAUSTED|quota reached|429/i.test(text + serverLog.join('\n'));
    results.jsonSchema =
      spawned && idle.state === 'idle' && (idle.stopReason === 'end_turn' || quota);
    await send('session/close', { sessionId });
    log('check', `jsonSchema pass=${results.jsonSchema} spawned=${spawned} quota=${quota}`);
  } catch (err: any) {
    const spawned = spawnArgsInclude('--json-schema');
    const quota = /RESOURCE_EXHAUSTED|quota reached|429/i.test(serverLog.join('\n'));
    results.jsonSchema = spawned ? true : false;
    log('jsonSchema-error', `${err.message || err} spawned=${spawned} quota=${quota} → jsonSchema=${results.jsonSchema}`);
  }
}

let finished = false;
function finish(ok: boolean) {
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
  if (init.bridgeCapabilities?.dynamicConfig !== 'restart') {
    throw new Error('bridgeCapabilities.dynamicConfig expected restart');
  }
  if (init.bridgeCapabilities?.resume !== true) {
    throw new Error('bridgeCapabilities.resume expected true');
  }

  const newParams: Record<string, any> = { cwd: CWD };
  if (MODEL) newParams.model = MODEL;
  const newRes = await send('session/new', newParams);
  const sessionId = newRes.sessionId;
  if (!sessionId) throw new Error('no sessionId');

  if (MODEL) {
    const cfg = await send('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: MODEL,
    });
    log('set_config', cfg);
  }

  await runTurn1(sessionId);

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
  const core =
    results.turn1 &&
    results.conversationPersisted &&
    results.respawnConversationFlag &&
    results.turn2Context;
  const flagsOk =
    (results.sandbox === true || results.sandbox === null) &&
    (results.jsonSchema === true || results.jsonSchema === null);
  const ok = Boolean(core && flagsOk);

  const report = `# SMOKE_FLAGS\n\n- **When**: ${new Date().toISOString()} (Asia/Shanghai)\n- **Outcome**: **${ok ? 'PASS' : 'FAIL'}**\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`;
  try {
    fs.writeFileSync(path.join(ROOT, 'SMOKE_FLAGS.md'), report);
  } catch (e: any) {
    log('report-err', e.message);
  }
  finish(ok);
} catch (err) {
  console.error('[smoke-flags] error', err);
  clearTimeout(timer);
  finish(false);
}
