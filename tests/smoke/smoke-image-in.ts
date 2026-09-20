#!/usr/bin/env bun
/**
 * Image INPUT smoke: send text + image (base64 tiny.png), expect agent answer (not ERROR).
 * Writes SMOKE_IMAGE_IN.md
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { ensurePath, DEFAULT_SERVER_PATH, FIXTURES_DIR } from './helpers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const SERVER = DEFAULT_SERVER_PATH;
const PNG = path.join(FIXTURES_DIR, 'tiny.png');
const OUT = path.join(ROOT, 'SMOKE_IMAGE_IN.md');
const CWD = path.join(ROOT, 'smoke-workdir-image-in');
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 180000);

fs.mkdirSync(CWD, { recursive: true });
ensurePath();

const pngBuf = fs.readFileSync(PNG);
const b64 = pngBuf.toString('base64');

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
const agentTexts: string[] = [];
const toolTitles: string[] = [];
const events: any[] = [];
let stagedNote = '';

function send(method: string, params?: any): Promise<any> {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg: any;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  events.push(msg);
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
    }
    if (u?.sessionUpdate === 'user_message') {
      const text = u.content?.map?.((c: any) => c.text).join('\n') || JSON.stringify(u.content);
      if (/agy-acp-staging|attached an image/i.test(text)) stagedNote = text.slice(0, 500);
    }
    if (u?.sessionUpdate === 'tool_call_update' && u.title) toolTitles.push(u.title);
    if (u?.sessionUpdate === 'state_update' && u.state === 'idle') {
      finish(u.stopReason || 'end_turn');
    }
  }
});

child.stderr.on('data', (buf) => {
  const s = buf.toString();
  if (/staged files:/i.test(s)) stagedNote += '\n' + s.trim();
  for (const line of s.split('\n')) {
    if (line.trim()) console.error(`[server] ${line}`);
  }
});

let finished = false;
function finish(stopReason: string) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  const answer = agentTexts.join('');
  const isError = /failed to feed agy|^ERROR\b/i.test(answer) && answer.length < 80;
  const hasAnswer = answer.trim().length > 0 && !isError;
  const pass = hasAnswer && stopReason !== 'timeout';
  const md = `# SMOKE_IMAGE_IN

- **When**: ${new Date().toISOString()} (box local Asia/Shanghai)
- **Outcome**: **${pass ? 'PASS' : 'FAIL'}**
- **stopReason**: ${stopReason}
- **Prompt**: text + image block (base64 fixtures/tiny.png — blue with white "HI")
- **Degrade**: richContentInput=degrade_to_files → \`.agy-acp-staging/<uuid>.png\` + text path ref

## Staged / user_message excerpt
\`\`\`
${stagedNote || '(see server stderr staged files)'}
\`\`\`

## Agent answer (quoted)
> ${answer.trim().replace(/\n/g, '\n> ') || '(empty)'}

## Tools seen
${toolTitles.length ? toolTitles.map((t) => `- ${t}`).join('\n') : '- (none)'}

## Notes
- agy stream-json stdin rejects non-text content blocks; bridge writes files and asks agent to view_file / @path.
`;
  fs.writeFileSync(OUT, md);
  console.log(md);
  console.log(`SMOKE_IMAGE_IN ${pass ? 'PASS' : 'FAIL'}`);
  try {
    child.stdin.end();
  } catch {
    /* */
  }
  child.kill('SIGTERM');
  setTimeout(() => process.exit(pass ? 0 : 1), 400).unref?.();
}

const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);

try {
  await send('initialize', {
    protocolVersion: 2,
    capabilities: {},
    info: { name: 'smoke-image-in', version: '0.0.1' },
  });
  const { sessionId } = await send('session/new', { cwd: CWD });
  await send('session/prompt', {
    sessionId,
    prompt: [
      {
        type: 'text',
        text: 'What single word is most visible or describe the dominant color in one short English sentence.',
      },
      {
        type: 'image',
        mimeType: 'image/png',
        data: b64,
      },
    ],
  });
} catch (err) {
  console.error(err);
  finish('error');
}
