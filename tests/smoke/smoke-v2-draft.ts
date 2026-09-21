#!/usr/bin/env bun
/**
 * Experimental Smoke driver for ACP v2 draft protocol:
 * Tests initialize (v2) → session/new (v2) → session/prompt (v2) with state_update lifecycle.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSmokeHarness } from './helpers.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CWD = process.env.SMOKE_CWD || path.resolve(__dirname, '../..');
const PROMPT = process.env.SMOKE_PROMPT || 'Reply with exactly: pong';
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 90000);

const harness = createSmokeHarness({ tag: 'smoke-v2-draft' });
const { child, send, log, events, waitIdle, kill } = harness;

let bridgeCapabilities: any = null;

try {
  const init = await send('initialize', {
    protocolVersion: 2,
    capabilities: {},
    info: { name: 'agy-acp-smoke-v2', title: 'Smoke v2 Draft', version: '0.0.1' },
  });
  if (init.protocolVersion !== 2) throw new Error(`expected protocolVersion 2, got ${init.protocolVersion}`);
  bridgeCapabilities = init.bridgeCapabilities || init._meta?.bridgeCapabilities || null;
  console.log('[smoke-v2] info.version=', init.info?.version || init.agentInfo?.version);
  console.log('[smoke-v2] bridgeCapabilities=', JSON.stringify(bridgeCapabilities));

  const { sessionId } = await send('session/new', { cwd: CWD });
  if (!sessionId) throw new Error('no sessionId');

  const promptPromise = send('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: PROMPT }],
  });

  const idle = await waitIdle(TIMEOUT_MS, sessionId);
  const promptRes = await promptPromise;
  const stopReason = idle?.stopReason || promptRes?.stopReason || 'unknown';

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
  const hasChunk = events.some(
    (e) => e.subTag === 'notify' && e.obj.params?.update?.sessionUpdate === 'agent_message_chunk',
  );
  const hasRunningState = events.some(
    (e) => e.subTag === 'notify' && e.obj.params?.update?.sessionUpdate === 'state_update' && e.obj.params.update.state === 'running',
  );
  const hasIdleState = events.some(
    (e) => e.subTag === 'notify' && e.obj.params?.update?.sessionUpdate === 'state_update' && e.obj.params.update.state === 'idle',
  );
  const hasBridgeCaps = Boolean(bridgeCapabilities?.prompt);

  const pass = hasInit && hasSession && hasChunk && hasRunningState && hasIdleState && hasBridgeCaps;
  console.log('---');
  console.log('bridgeCapabilities:', JSON.stringify(bridgeCapabilities, null, 2));
  console.log(`SMOKE V2 DRAFT ${pass ? 'PASS' : 'FAIL'} stopReason=${stopReason}`);
  console.log(
    `checks: init=${hasInit} session=${hasSession} chunk=${hasChunk} runningState=${hasRunningState} idleState=${hasIdleState} bridgeCaps=${hasBridgeCaps}`,
  );
  console.log(`sequence: ${kinds.join(' → ')}`);

  kill('SIGTERM');
  process.exit(pass ? 0 : 1);
} catch (err: any) {
  console.error('[smoke-v2] error', err);
  kill('SIGTERM');
  process.exit(1);
}
