#!/usr/bin/env bun
/**
 * Offline demo: map agy stream-json NDJSON lines → ACP session/update envelopes.
 * Uses shared lib/map-agy-to-acp.mjs (same mapping as the live server).
 */
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import {
  createMapperState,
  mapAgyEvent,
} from './lib/map-agy-to-acp.ts';

const sessionId = process.env.ACP_SESSION_ID || 'demo-session';
const path = process.argv[2];
const input = path ? createReadStream(path) : process.stdin;
const rl = createInterface({ input, crlfDelay: Infinity });

let state = createMapperState();

for await (const line of rl) {
  const t = line.trim();
  if (!t) continue;
  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    console.error('skip bad json:', t.slice(0, 80));
    continue;
  }
  const { notifications, state: next } = mapAgyEvent(sessionId, obj, state);
  state = next;
  for (const n of notifications) {
    console.log(
      JSON.stringify({
        kind: n.params?.update?.sessionUpdate || 'notify',
        acp: n,
        conversationId: state.conversationId,
      }),
    );
  }
  if (state.turnDone) {
    console.log(
      JSON.stringify({
        kind: 'prompt_done',
        stopReason: state.lastStopReason,
        conversationId: state.conversationId,
      }),
    );
  }
}
