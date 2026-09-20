#!/usr/bin/env bun
/**
 * Smoke driver: spawn server.ts, run initialize → session/new → session/prompt,
 * print updates + bridgeCapabilities, exit when idle end_turn (or timeout).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSmokeHarness } from './helpers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = process.env.SMOKE_CWD || path.resolve(__dirname, '../..');
const PROMPT = process.env.SMOKE_PROMPT || 'Reply with exactly: pong';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000);

const harness = createSmokeHarness({ tag: 'smoke-basic' });
const { child, send, log, events, waitIdle, kill } = harness;

let bridgeCapabilities: any = null;

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

  const idle = await waitIdle(TIMEOUT_MS, sessionId);
  const stopReason = idle.stopReason || 'unknown';

  const kinds = events
    .filter((e) => e.subTag === 'notify' || e.subTag === '←')
    .map((e) => {
      if (e.subTag === '←') {
        return `response:${e.obj.result ? Object.keys(e.obj.result).join(',') : 'error'}`;
      }
      const u = e.obj.params?.update;
      return u?.sessionUpdate || e.obj.method;
    });

  const hasInit = events.some((e) => e.subTag === '←' && e.obj.result?.protocolVersion === 2);
  const hasSession = events.some((e) => e.subTag === '←' && e.obj.result?.sessionId);
  const hasMessageId = events.some((e) => e.subTag === '←' && e.obj.result?.messageId);
  const hasChunk = events.some(
    (e) => e.subTag === 'notify' && e.obj.params?.update?.sessionUpdate === 'agent_message_chunk',
  );
  const hasIdle = events.some(
    (e) =>
      e.subTag === 'notify' &&
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

  kill('SIGTERM');
  process.exit(pass ? 0 : 1);
} catch (err: any) {
  console.error('[smoke] error', err);
  kill('SIGTERM');
  process.exit(1);
}
