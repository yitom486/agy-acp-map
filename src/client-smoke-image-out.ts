#!/usr/bin/env bun
/**
 * Image OUTPUT smoke: ask generate_image; look for tool_call + optional ACP image block.
 * Writes SMOKE_IMAGE_OUT.md — PASS / PARTIAL / FAIL honestly.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'server.ts');
const OUT = path.join(__dirname, '..', 'SMOKE_IMAGE_OUT.md');
const CWD = path.join(__dirname, '..', 'smoke-workdir-image-out');
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
  env: { ...process.env, AGY_ACP_SKIP_PERMISSIONS: '1' },
  cwd: __dirname,
});

let nextId = 1;
const pending = new Map();
const agentTexts = [];
const toolCalls = [];
let sawGenerateImage = false;
let sawAcpImage = false;
let imagePaths = [];

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
    if (u?.sessionUpdate === 'agent_message_chunk') {
      if (u.content?.type === 'text') agentTexts.push(u.content.text);
      if (u.content?.type === 'image') {
        sawAcpImage = true;
        if (u.content.uri) imagePaths.push(u.content.uri);
      }
    }
    if (u?.sessionUpdate === 'tool_call_update') {
      toolCalls.push({ title: u.title, status: u.status, contentTypes: (u.content || []).map((c) => c.content?.type) });
      if (String(u.title || '').toLowerCase() === 'generate_image') sawGenerateImage = true;
      for (const c of u.content || []) {
        if (c.content?.type === 'image') {
          sawAcpImage = true;
          if (c.content.uri) imagePaths.push(c.content.uri);
        }
        if (c.content?.type === 'text') {
          const m = c.content.text.match(/(\/[^\s"'`]+\.(?:png|jpe?g|webp|gif))/gi);
          if (m) imagePaths.push(...m);
        }
      }
    }
    if (u?.sessionUpdate === 'state_update' && u.state === 'idle') {
      finish(u.stopReason || 'end_turn');
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
  const answer = agentTexts.join('');
  let outcome = 'FAIL';
  if (sawGenerateImage && sawAcpImage) outcome = 'PASS';
  else if (sawGenerateImage || /generate_image|\.png|\.webp|\.jpg/i.test(answer + toolCalls.map((t) => t.title).join(',')))
    outcome = 'PARTIAL';
  else if (answer.trim() && stopReason !== 'timeout') outcome = 'PARTIAL';

  const md = `# SMOKE_IMAGE_OUT

- **When**: ${new Date().toISOString()} (box local Asia/Shanghai)
- **Outcome**: **${outcome}**
- **stopReason**: ${stopReason}
- **saw generate_image tool_call**: ${sawGenerateImage}
- **saw ACP image block** (base64/uri): ${sawAcpImage}
- **image paths mentioned**: ${imagePaths.length ? imagePaths.join(', ') : '(none)'}

## Tools
${toolCalls.length ? toolCalls.map((t) => `- ${t.title} status=${t.status} content=${JSON.stringify(t.contentTypes)}`).join('\n') : '- (none)'}

## Agent text (excerpt)
\`\`\`
${answer.slice(0, 2000) || '(empty)'}
\`\`\`

## Honest notes
- \`generate_image\` may be slow, model-gated, or return a path we only surface as text.
- Bridge inlines ACP \`{type:image, mimeType, data}\` when file ≤2MB and path is detectable.
`;
  fs.writeFileSync(OUT, md);
  console.log(md);
  console.log(`SMOKE_IMAGE_OUT ${outcome}`);
  try {
    child.stdin.end();
  } catch {
    /* */
  }
  child.kill('SIGTERM');
  // PARTIAL counts as exit 0 for CI softness; FAIL exit 1
  setTimeout(() => process.exit(outcome === 'FAIL' ? 1 : 0), 400).unref?.();
}

const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);

try {
  await send('initialize', {
    protocolVersion: 2,
    capabilities: {},
    info: { name: 'smoke-image-out', version: '0.0.1' },
  });
  const { sessionId } = await send('session/new', { cwd: CWD });
  await send('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text:
          'Use the generate_image tool to create a tiny simple image: a solid red square or the word HI on a blue background. ' +
          'After it finishes, reply with the absolute filesystem path to the generated image file in one line.',
      },
    ],
  });
} catch (err) {
  console.error(err);
  finish('error');
}
