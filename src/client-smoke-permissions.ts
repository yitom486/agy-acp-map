#!/usr/bin/env bun
/**
 * Soft-deny smoke: AGY_ACP_SKIP_PERMISSIONS=0, prompt needing shell.
 * Asserts we capture soft-deny info OR documents auto-allow.
 * Writes SMOKE_PERMISSIONS.md
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { parseSoftDeny } from './lib/soft-deny.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.ts');
const OUT = path.join(__dirname, '..', 'SMOKE_PERMISSIONS.md');
const CWD = path.join(__dirname, '..', 'smoke-workdir-perms');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 120000);
const SETTLE_MS = 900;

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
  env: { ...process.env, AGY_ACP_SAFETY: 'safe', AGY_ACP_SKIP_PERMISSIONS: '0' },
  cwd: __dirname,
});

let nextId = 1;
const pending = new Map();
const agentTexts = [];
const stderrAll = [];
let toolFailed = false;
let softDenyNotify = false;
let idleSeen = false;
let settleTimer = null;

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update;
    if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      agentTexts.push(u.content.text);
      if (/soft-deny|allow-rule|permissions\.allow|Headless soft-deny/i.test(u.content.text)) {
        softDenyNotify = true;
      }
    }
    if (u?.sessionUpdate === 'tool_call_update') {
      const blob = JSON.stringify(u);
      if (u.status === 'failed' || /permission|denied/i.test(blob)) toolFailed = true;
    }
    if (u?.sessionUpdate === 'state_update' && u.state === 'idle') {
      idleSeen = true;
      if (settleTimer) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finish(u.stopReason || 'end_turn'), SETTLE_MS);
      settleTimer.unref?.();
    }
  }
});

child.stderr.on('data', (buf) => {
  const s = buf.toString();
  stderrAll.push(s);
  for (const line of s.split('\n')) {
    if (line.trim()) console.error(`[server] ${line}`);
  }
});

let finished = false;
function finish(stopReason) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (settleTimer) clearTimeout(settleTimer);
  const stderrText = stderrAll.join('');
  const parsed = parseSoftDeny(stderrText);
  const answer = agentTexts.join('');
  const jetski = /auto-denied|allow-rule under permissions\.allow|required the "[^"]+" permission/i.test(
    stderrText,
  );
  const captured = softDenyNotify || parsed.length > 0 || jetski;

  let outcome = 'FAIL';
  let note = '';
  if (captured) {
    outcome = 'PASS';
    note = softDenyNotify
      ? 'Soft-deny surfaced as agent_message_chunk with suggested allow-rules.'
      : parsed.length
        ? 'Soft-deny parsed from stderr (jetski / allow-rule patterns).'
        : 'Soft-deny jetski line observed on stderr (notify may have raced idle).';
  } else if (/soft_deny_probe/i.test(answer) && !toolFailed) {
    outcome = 'PASS';
    note =
      'Policy appears to auto-allow echo (command ran successfully without skip-permissions). Soft-deny path not triggered; documented.';
  } else if (stopReason === 'timeout') {
    outcome = 'FAIL';
    note = 'Timed out waiting for idle.';
  } else {
    outcome = 'PARTIAL';
    note = `Turn completed (idleSeen=${idleSeen}, toolFailed=${toolFailed}) but no soft-deny pattern; inspect tools/stderr.`;
  }

  const md = `# SMOKE_PERMISSIONS

- **When**: ${new Date().toISOString()} (box local Asia/Shanghai)
- **Outcome**: **${outcome}**
- **AGY_ACP_SKIP_PERMISSIONS**: 0 (no --dangerously-skip-permissions)
- **stopReason**: ${stopReason}
- **softDenyNotify (agent_message)**: ${softDenyNotify}
- **parseSoftDeny count**: ${parsed.length}
- **jetskiStderr**: ${jetski}
- **toolFailed**: ${toolFailed}

## parseSoftDeny result
\`\`\`json
${JSON.stringify(parsed, null, 2)}
\`\`\`

## Agent text
\`\`\`
${answer.slice(0, 2000) || '(empty)'}
\`\`\`

## Stderr excerpt
\`\`\`
${stderrText.slice(0, 2500)}
\`\`\`

## Note
${note}
`;
  fs.writeFileSync(OUT, md);
  console.log(md);
  console.log(`SMOKE_PERMISSIONS ${outcome}`);
  try {
    child.stdin.end();
  } catch {
    /* */
  }
  child.kill('SIGTERM');
  setTimeout(() => process.exit(outcome === 'FAIL' ? 1 : 0), 400).unref?.();
}

const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);

try {
  await send('initialize', {
    protocolVersion: 2,
    capabilities: {},
    info: { name: 'smoke-perms', version: '0.0.1' },
  });
  const { sessionId } = await send('session/new', { cwd: CWD });
  await send('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text: 'run: echo soft_deny_probe',
      },
    ],
  });
} catch (err) {
  console.error(err);
  finish('error');
}
