import { describe, expect, test } from 'bun:test';
import {
  createMapperState,
  resetTurnState,
  mapAgyEvent,
  guessToolKind,
  buildAgyUserMessage,
  promptBlocksToText,
} from './map-agy-to-acp.ts';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

describe('mapper basics', () => {
  test('guessToolKind', () => {
    expect(guessToolKind('run_command')).toBe('execute');
    expect(guessToolKind('view_file')).toBe('read');
    expect(guessToolKind('write_to_file')).toBe('edit');
    expect(guessToolKind('generate_image')).toBe('other');
  });

  test('buildAgyUserMessage', () => {
    const msg = buildAgyUserMessage('hi');
    expect(msg.event).toBe('user');
    expect((msg as { message: { content: { type: string; text: string }[] } }).message.content[0]!.text).toBe('hi');
  });

  test('promptBlocksToText skips image without staging', () => {
    const { text, notes } = promptBlocksToText([
      { type: 'text', text: 'a' },
      { type: 'image', data: 'xxx' },
    ]);
    expect(text).toBe('a');
    expect(notes.some((n) => /image/i.test(n))).toBe(true);
  });

  test('resetTurnState keeps conversationId', () => {
    const s = createMapperState();
    s.conversationId = 'c1';
    const n = resetTurnState(s);
    expect(n.conversationId).toBe('c1');
    expect(n.turnDone).toBe(false);
  });
});

describe('mapAgyEvent', () => {
  test('init captures conversation_id', () => {
    let state = createMapperState();
    const { notifications, state: next } = mapAgyEvent('s1', {
      event: 'init',
      conversation_id: 'conv-1',
      init: { tools: ['run_command'], permission_mode: 'default' },
    }, state);
    expect(notifications.length).toBe(0);
    expect(next.conversationId).toBe('conv-1');
  });

  test('agent_response text_delta → agent_message_chunk', () => {
    let state = createMapperState();
    const { notifications } = mapAgyEvent('s1', {
      event: 'step_update',
      step_update: {
        step_index: 1,
        step_type: 'agent_response',
        state: 'ACTIVE',
        text_delta: 'hello',
      },
    }, state);
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.params.update.sessionUpdate).toBe('agent_message_chunk');
    expect(notifications[0]!.params.update.content.text).toBe('hello');
  });

  test('agent_response thought_delta → agent_thought_chunk', () => {
    let state = createMapperState();
    const { notifications, state: nextState } = mapAgyEvent('s1', {
      event: 'step_update',
      step_update: {
        step_index: 1,
        step_type: 'agent_response',
        state: 'ACTIVE',
        thought_delta: 'Thinking through the solution...',
      },
    }, state);
    expect(notifications.length).toBe(1);
    expect(notifications[0]!.params.update.sessionUpdate).toBe('agent_thought_chunk');
    expect(notifications[0]!.params.update.content.text).toBe('Thinking through the solution...');
    expect(nextState.emittedThoughtDelta).toBe(true);
  });

  test('tool ACTIVE then DONE', () => {
    let state = createMapperState();
    let r = mapAgyEvent('s1', {
      event: 'step_update',
      step_update: {
        step_index: 2,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo' } },
      },
    }, state);
    state = r.state;
    expect(r.notifications[0]!.params.update.sessionUpdate).toBe('tool_call');
    expect(r.notifications[0]!.params.update.status).toBe('in_progress');
    r = mapAgyEvent('s1', {
      event: 'step_update',
      step_update: {
        step_index: 2,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', output: 'ok' },
      },
    }, state);
    expect(
      r.notifications.some(
        (n) =>
          n.params.update.sessionUpdate === 'tool_call_update' &&
          n.params.update.status === 'completed',
      ),
    ).toBe(true);
  });

  test('toolCallId stable within turn, unique across turns', () => {
    let state = createMapperState();
    const toolEvt = {
      event: 'step_update',
      step_update: {
        step_index: 1,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { path: 'a.ts', line: 12 } },
      },
    };
    let r = mapAgyEvent('s1', toolEvt, state);
    state = r.state;
    const id1 = r.notifications[0]!.params.update.toolCallId as string;
    expect(id1).toBe('agy-t0-s1');
    expect(r.notifications[0]!.params.update.name).toBe('view_file');
    expect(r.notifications[0]!.params.update.title).toContain('a.ts');
    expect(r.notifications[0]!.params.update.locations).toEqual([{ path: 'a.ts', line: 12 }]);
    // DONE in same turn reuses id
    r = mapAgyEvent('s1', {
      event: 'step_update',
      step_update: {
        step_index: 1,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'view_file',
        tool_info: { name: 'view_file', parameters: { path: 'a.ts' }, output: 'ok' },
      },
    }, state);
    state = r.state;
    const done = r.notifications.find((n) => n.params.update.sessionUpdate === 'tool_call_update');
    expect(done!.params.update.toolCallId).toBe(id1);
    // Next turn same step_index gets a fresh id so Zed never merges cards
    state = resetTurnState(state);
    r = mapAgyEvent('s1', toolEvt, state);
    const id2 = r.notifications[0]!.params.update.toolCallId as string;
    expect(id2).not.toBe(id1);
    expect(id2).toBe('agy-t1-s1');
  });

  test('real wire shape: view_file AbsolutePath maps to title+locations+preview', () => {
    let state = createMapperState();
    const r = mapAgyEvent('s1', {
      event: 'step_update',
      step_update: {
        step_index: 6,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: 'D:/project/js/app/package.json' },
        },
      },
    }, state);
    const call = r.notifications[0]!.params.update;
    expect(call.sessionUpdate).toBe('tool_call');
    expect(call.name).toBe('view_file');
    expect(call.title).toContain('package.json');
    expect(call.locations).toEqual([{ path: 'D:/project/js/app/package.json' }]);
    expect(JSON.stringify(call.content)).toContain('package.json');
  });

  test('real wire shape: usage exposes thinking breakdown in _meta', () => {
    const state = createMapperState();
    const { notifications } = mapAgyEvent('s1', {
      event: 'result',
      result: {
        status: 'SUCCESS',
        conversation_id: 'c1',
        response: 'done',
        usage: { total_tokens: 100, thinking_tokens: 20, input_tokens: 70, output_tokens: 10 },
      },
    }, state);
    const usage = notifications.find((n) => n.params.update.sessionUpdate === 'usage_update');
    expect(usage!.params.update.used).toBe(100);
    expect(usage!.params.update._meta).toMatchObject({ thinkingTokens: 20, inputTokens: 70, outputTokens: 10 });
  });

  test('result SUCCESS → idle end_turn + usage', () => {
    let state = createMapperState();
    const { notifications, state: next } = mapAgyEvent('s1', {
      event: 'result',
      result: {
        status: 'SUCCESS',
        conversation_id: 'c9',
        response: 'done',
        usage: { total_tokens: 100 },
      },
    }, state);
    expect(next.turnDone).toBe(true);
    expect(next.conversationId).toBe('c9');
    expect(notifications.some((n) => n.params.update.sessionUpdate === 'usage_update')).toBe(true);
    expect(notifications.some((n) => n.params.update.sessionUpdate === 'state_update' && n.params.update.state === 'idle')).toBe(true);
  });

  test('result structured_output → agent_message_chunk JSON fence', () => {
    let state = createMapperState();
    const structured = { word: 'schemaok', n: 1 };
    const { notifications, state: next } = mapAgyEvent('s1', {
      event: 'result',
      result: {
        status: 'SUCCESS',
        conversation_id: 'c-struct',
        response: 'ok',
        structured_output: structured,
        usage: { total_tokens: 10 },
      },
    }, state);
    expect(next.turnDone).toBe(true);
    const chunk = notifications.find(
      (n) =>
        n.params.update.sessionUpdate === 'agent_message_chunk' &&
        typeof n.params.update.content?.text === 'string' &&
        n.params.update.content.text.includes('```json'),
    );
    expect(chunk).toBeTruthy();
    expect(chunk!.params.update.content.text).toContain('"word"');
    expect(chunk!.params.update.content.text).toContain('schemaok');
    expect(chunk!.params.update._meta?.structuredOutput).toEqual(structured);
    expect(notifications.some((n) => n.params.update.sessionUpdate === 'state_update')).toBe(true);
  });

  test('offline sample_success.ndjson maps', async () => {
    const sample = path.join(import.meta.dir, '..', '..', 'sample_success.ndjson');
    let state = createMapperState();
    let total = 0;
    const rl = createInterface({ input: createReadStream(sample), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const { notifications, state: next } = mapAgyEvent('demo', JSON.parse(line), state);
      state = next;
      total += notifications.length;
    }
    expect(state.conversationId).toBeTruthy();
    expect(total).toBeGreaterThan(0);
  });
});

describe('v0.1.3 mapper hardening', () => {
  test('result.response fallback when no text_delta', () => {
    let state = createMapperState();
    const { notifications, state: next } = mapAgyEvent(
      's1',
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          conversation_id: 'c-fallback',
          response: 'only in result.response',
          usage: { total_tokens: 5 },
        },
      },
      state,
    );
    expect(next.turnDone).toBe(true);
    expect(next.emittedTextDelta).toBe(true);
    const chunk = notifications.find(
      (n) =>
        n.params.update.sessionUpdate === 'agent_message_chunk' &&
        n.params.update.content?.text === 'only in result.response',
    );
    expect(chunk).toBeTruthy();
    expect(chunk!.params.update._meta?.fromResultResponse).toBe(true);
  });

  test('does not duplicate response when text_delta already emitted', () => {
    let state = createMapperState();
    let r = mapAgyEvent(
      's1',
      {
        event: 'step_update',
        step_update: {
          step_index: 1,
          step_type: 'agent_response',
          state: 'ACTIVE',
          text_delta: 'streamed',
        },
      },
      state,
    );
    state = r.state;
    r = mapAgyEvent(
      's1',
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'streamed full',
        },
      },
      state,
    );
    const fallbacks = r.notifications.filter(
      (n) => n.params.update._meta?.fromResultResponse === true,
    );
    expect(fallbacks.length).toBe(0);
  });

  test('CANCELLED / INTERRUPTED → stopReason cancelled', () => {
    for (const status of ['CANCELLED', 'INTERRUPTED', 'CANCELED', 'ABORTED']) {
      const state = createMapperState();
      const { notifications, state: next } = mapAgyEvent(
        's1',
        { event: 'result', result: { status, response: 'stopped' } },
        state,
      );
      expect(next.lastStopReason).toBe('cancelled');
      const idle = notifications.find(
        (n) => n.params.update.sessionUpdate === 'state_update',
      );
      expect(idle!.params.update.stopReason).toBe('cancelled');
    }
  });
});
