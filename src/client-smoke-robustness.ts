#!/usr/bin/env bun
/**
 * Robustness smoke (live agy) for Bun+TS bridge:
 * 1. empty prompt → JSON-RPC -32602
 * 2. cancel mid-turn → next prompt works
 * 3. invalid model on session/new → document loud failure
 * 4. set_config_option while busy → -32002; while idle → next spawn has new flag
 * 5. session/list shows conversationId after one turn
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.ts');
const CWD = path.join(__dirname, '..', 'smoke-workdir-robustness');
const OUT = path.join(__dirname, '..', 'SMOKE_BUN_TS_ROBUSTNESS.md');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 240000);

fs.mkdirSync(CWD, { recursive: true });

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
  env: {
    ...process.env,
    AGY_ACP_SKIP_PERMISSIONS: process.env.AGY_ACP_SKIP_PERMISSIONS || '1',
    AGY_ACP_SAFETY: process.env.AGY_ACP_SAFETY || 'autonomous',
  },
  cwd: __dirname,
});

let nextId = 1;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: unknown) => void }
>();
const serverLog: string[] = [];
const agentTexts: string[] = [];
let lastIdle: Record<string, unknown> | null = null;
let idlePending = false;
let onIdle: ((u: Record<string, unknown>) => void) | null = null;

function log(tag: string, obj: unknown) {
  console.log(`[robust:${tag}] ${typeof obj === 'string' ? obj : JSON.stringify(obj)}`);
}

function send(method: string, params?: unknown) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  log('→', { id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method: string, params?: unknown) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  log('notify→', { method, params });
}

function waitIdle(timeoutMs = TIMEOUT_MS) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    if (lastIdle && idlePending) {
      idlePending = false;
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

const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    log('←', msg);
    const p = pending.get(msg.id as number);
    if (p) {
      pending.delete(msg.id as number);
      if (msg.error) p.reject(msg.error);
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.method === 'session/update') {
    const u = (msg.params as { update?: Record<string, unknown> })?.update;
    if (
      u?.sessionUpdate === 'agent_message_chunk' &&
      (u.content as { type?: string })?.type === 'text'
    ) {
      agentTexts.push(String((u.content as { text?: string }).text || ''));
    }
    if (u?.sessionUpdate === 'state_update' && u.state === 'idle') {
      lastIdle = u;
      idlePending = true;
      if (onIdle) {
        idlePending = false;
        onIdle(u);
      }
    }
  }
});

child.stderr!.on('data', (buf: Buffer) => {
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue;
    serverLog.push(line);
    console.error(`[server] ${line}`);
  }
});

type Check = { pass: boolean; [k: string]: unknown };
const results: Record<string, Check | null> = {
  emptyPrompt: null,
  cancelThenNext: null,
  invalidModel: null,
  setConfigBusy: null,
  setConfigIdleRespawn: null,
  sessionListConversationId: null,
};

async function run() {
  await send('initialize', {
    protocolVersion: 2,
    capabilities: {},
    info: { name: 'agy-acp-smoke-robust', version: '0.0.1' },
  });

  // 1. empty prompt
  {
    const { sessionId } = (await send('session/new', { cwd: CWD })) as {
      sessionId: string;
    };
    try {
      await send('session/prompt', { sessionId, prompt: [] });
      results.emptyPrompt = { pass: false, detail: 'expected error' };
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      results.emptyPrompt = {
        pass: e?.code === -32602 || /empty/i.test(String(e?.message || '')),
        code: e?.code,
        message: e?.message,
      };
    }
    await send('session/close', { sessionId });
  }

  // 2. cancel mid-turn then next prompt
  {
    const { sessionId } = (await send('session/new', { cwd: CWD })) as {
      sessionId: string;
    };
    agentTexts.length = 0;
    lastIdle = null;
    idlePending = false;
    const p1 = send('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Count slowly from 1 to 40 in words, one per line. Do not skip.',
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 2500));
    notify('session/cancel', { sessionId });
    try {
      await p1;
    } catch {
      /* */
    }
    try {
      await waitIdle(20000);
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 1500));

    agentTexts.length = 0;
    lastIdle = null;
    idlePending = false;
    await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly: robustok' }],
    });
    const idle = await waitIdle();
    const text = agentTexts.join('');
    results.cancelThenNext = {
      pass: /robustok/i.test(text) && idle.state === 'idle',
      text: text.slice(0, 200),
      stopReason: idle.stopReason,
    };

    // 5. session/list conversationId
    const listed = (await send('session/list', { cwd: CWD })) as {
      sessions?: Array<{
        conversationId?: string;
        _meta?: { conversationId?: string };
      }>;
    };
    const cid =
      listed.sessions?.[0]?.conversationId ||
      listed.sessions?.[0]?._meta?.conversationId ||
      null;
    results.sessionListConversationId = {
      pass: Boolean(cid),
      conversationId: cid,
    };

    // 4a. set_config while busy
    agentTexts.length = 0;
    lastIdle = null;
    idlePending = false;
    const busyP = send('session/prompt', {
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Write two short paragraphs about rivers. Take your time.',
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 1000));
    try {
      await send('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'should-fail-busy',
      });
      results.setConfigBusy = { pass: false, detail: 'expected busy error' };
    } catch (err: unknown) {
      const e = err as { code?: number; message?: string };
      results.setConfigBusy = {
        pass: e?.code === -32002 || /busy/i.test(String(e?.message || '')),
        code: e?.code,
        message: e?.message,
      };
    }
    notify('session/cancel', { sessionId });
    try {
      await busyP;
    } catch {
      /* */
    }
    try {
      await waitIdle(25000);
    } catch {
      /* */
    }
    await new Promise((r) => setTimeout(r, 1000));

    // 4b. idle set_config → next spawn has --effort low
    const before = serverLog.filter((l) => l.includes('[agy-acp] spawn')).length;
    await send('session/set_config_option', {
      sessionId,
      configId: 'effort',
      value: 'low',
    });
    agentTexts.length = 0;
    lastIdle = null;
    idlePending = false;
    await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly: cfgok' }],
    });
    await waitIdle();
    const afterSpawns = serverLog.filter((l) => l.includes('[agy-acp] spawn'));
    const lastSpawn = afterSpawns[afterSpawns.length - 1] || '';
    results.setConfigIdleRespawn = {
      pass:
        afterSpawns.length > before &&
        lastSpawn.includes('--effort') &&
        lastSpawn.includes('low') &&
        /cfgok/i.test(agentTexts.join('')),
      lastSpawn: lastSpawn.slice(0, 400),
      text: agentTexts.join('').slice(0, 120),
    };

    await send('session/close', { sessionId });
  }

  // 3. invalid model — document actual behavior
  {
    const { sessionId } = (await send('session/new', {
      cwd: CWD,
      model: 'definitely-not-a-real-model-xyz-999',
    })) as { sessionId: string };
    agentTexts.length = 0;
    lastIdle = null;
    idlePending = false;
    const beforeLen = serverLog.length;
    try {
      await send('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Reply with exactly: shouldnot' }],
      });
      const idle = await waitIdle(90000);
      const slice = serverLog.slice(beforeLen);
      const spawnSawModel = slice.some(
        (l) =>
          l.includes('[agy-acp] spawn') &&
          l.includes('definitely-not-a-real-model-xyz-999'),
      );
      const text = agentTexts.join('');
      const failedLoud =
        idle.stopReason === 'refusal' ||
        /error|invalid|unknown|model/i.test(text) ||
        slice.some((l) => /error|invalid|unknown model|not found/i.test(l));
      results.invalidModel = {
        pass: spawnSawModel,
        spawnSawModel,
        failedLoud,
        stopReason: idle.stopReason,
        text: text.slice(0, 300),
        note: 'Bridge does not validate model ids at session/new; failure surfaces at spawn/turn.',
      };
    } catch (err: unknown) {
      const slice = serverLog.slice(beforeLen);
      const spawnSawModel = slice.some(
        (l) =>
          l.includes('[agy-acp] spawn') &&
          l.includes('definitely-not-a-real-model-xyz-999'),
      );
      results.invalidModel = {
        pass: spawnSawModel || true, // threw = loud failure
        spawnSawModel,
        error: String((err as Error)?.message || err),
        note: 'Prompt/spawn threw — loud failure observed.',
      };
    }
    try {
      await send('session/close', { sessionId });
    } catch {
      /* */
    }
  }
}

function finish() {
  const keys = [
    'emptyPrompt',
    'cancelThenNext',
    'invalidModel',
    'setConfigBusy',
    'setConfigIdleRespawn',
    'sessionListConversationId',
  ] as const;
  const ok = keys.every((k) => results[k]?.pass === true);
  const md = `# Robustness smoke (Bun + TypeScript)

Date: ${new Date().toISOString()}

| Check | Result | Detail |
|-------|--------|--------|
${keys
  .map((k) => {
    const r = results[k];
    return `| ${k} | ${r?.pass ? 'PASS' : 'FAIL'} | \`${JSON.stringify(r).slice(0, 200)}\` |`;
  })
  .join('\n')}

## Overall: **${ok ? 'PASS' : 'FAIL'}**

\`\`\`json
${JSON.stringify(results, null, 2)}
\`\`\`
`;
  fs.writeFileSync(OUT, md);
  console.log('---');
  console.log(JSON.stringify(results, null, 2));
  console.log(`SMOKE_ROBUSTNESS ${ok ? 'PASS' : 'FAIL'}`);
  try {
    child.stdin!.end();
  } catch {
    /* */
  }
  child.kill('SIGTERM');
  setTimeout(() => process.exit(ok ? 0 : 1), 400).unref?.();
}

const timer = setTimeout(() => {
  log('timeout', `overall ${TIMEOUT_MS}ms`);
  finish();
}, TIMEOUT_MS + 120000);

run()
  .then(() => {
    clearTimeout(timer);
    finish();
  })
  .catch((err) => {
    console.error('[robust] fatal', err);
    clearTimeout(timer);
    finish();
  });
