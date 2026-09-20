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
    expect(r.notifications.some((n) => n.params.update.status === 'completed')).toBe(true);
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

describe('v0.5.0 mapper hardening', () => {
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
