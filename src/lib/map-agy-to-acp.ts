/**
 * Pure-ish mapping: agy stream-json NDJSON events → ACP v2 session/update notifications.
 * Image inlining uses fs via rich-content.ts (best-effort). Offline map.mjs still works.
 */
import { buildRichToolContent, extractImagePaths, fileToAcpImageBlock } from './rich-content.ts';

export interface MapperState {
  conversationId?: string;
  tools?: string[];
  permissionMode?: string;
  agentMessageIds: Map<number, string>;
  toolSeen: Set<number>;
  lastStopReason?: string;
  turnDone?: boolean;
  emittedImageUris: Set<string>;
}

export interface AcpNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}


export function createMapperState(): MapperState {
  return {
    conversationId: undefined,
    tools: undefined,
    permissionMode: undefined,
    agentMessageIds: new Map(),
    toolSeen: new Set(),
    lastStopReason: undefined,
    turnDone: false,
    emittedImageUris: new Set(),
  };
}

/** Reset per-turn tracking (keep conversationId / tools). */
export function resetTurnState(state: MapperState): MapperState {
  return {
    ...state,
    agentMessageIds: new Map(),
    toolSeen: new Set(),
    lastStopReason: undefined,
    turnDone: false,
    emittedImageUris: new Set(),
  };
}

export function guessToolKind(name: unknown): string {
  const n = String(name || '').toLowerCase();
  if (n === 'run_command' || n.includes('command') || n === 'execute_browser_javascript') {
    return 'execute';
  }
  if (
    n === 'view_file' ||
    n.startsWith('read_') ||
    n === 'list_dir' ||
    n === 'grep_search' ||
    n === 'find_by_name' ||
    n === 'search_web'
  ) {
    return 'read';
  }
  if (
    n === 'write_to_file' ||
    n.startsWith('replace_') ||
    n.startsWith('multi_replace') ||
    n === 'sed_file' ||
    n === 'notebook_edit'
  ) {
    return 'edit';
  }
  if (n === 'generate_image') return 'other';
  if (n.includes('delete')) return 'delete';
  if (n.includes('search') || n.includes('grep')) return 'search';
  return 'other';
}

function notify(sessionId, update) {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  };
}

function agentMessageIdForStep(state, stepIndex) {
  if (!state.agentMessageIds.has(stepIndex)) {
    state.agentMessageIds.set(stepIndex, `msg_agent_agy_${stepIndex}`);
  }
  return state.agentMessageIds.get(stepIndex);
}

function stringifyOut(output, error) {
  if (error != null && error !== '') {
    if (typeof error === 'string') return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  if (output == null) return '';
  return typeof output === 'string' ? output : JSON.stringify(output);
}

/**
 * Emit agent_message_chunk image blocks for newly seen image paths (≤2MB).
 * @param {string} sessionId
 * @param {MapperState} state
 * @param {string[]} paths
 * @param {object[]} notifications
 */
function emitImageAgentChunks(sessionId, state, paths, notifications) {
  for (const p of paths) {
    const img = fileToAcpImageBlock(p);
    if (!img) continue;
    const key = img.uri || p;
    if (state.emittedImageUris.has(key)) continue;
    state.emittedImageUris.add(key);
    notifications.push(
      notify(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: `msg_agent_agy_image_${state.emittedImageUris.size}`,
        content: img,
      }),
    );
  }
}

/**
 * Map one agy NDJSON event object into zero or more ACP session/update notifications.
 * @param {string} sessionId
 * @param {object} event
 * @param {MapperState} state mutable mapper state (updated in place)
 * @returns {{ notifications: object[], state: MapperState }}
 */
export function mapAgyEvent(sessionId: string, event: unknown, state: MapperState): { notifications: AcpNotification[]; state: MapperState } {
  const notifications = [];
  if (!event || typeof event !== 'object') {
    return { notifications, state };
  }
  if (!state.emittedImageUris) state.emittedImageUris = new Set();

  if (event.event === 'init') {
    state.conversationId = event.conversation_id || state.conversationId;
    state.tools = event.init?.tools;
    state.permissionMode = event.init?.permission_mode;
    return { notifications, state };
  }

  if (event.event === 'step_update') {
    const s = event.step_update || {};
    const stepIndex = s.step_index;
    const stepType = s.step_type;
    const stepState = s.state; // ACTIVE | DONE | ERROR | ...

    if (stepType === 'user_input') {
      return { notifications, state };
    }

    if (stepType === 'agent_response') {
      const text = s.text_delta;
      if (typeof text === 'string' && text.length > 0) {
        const messageId = agentMessageIdForStep(state, stepIndex);
        notifications.push(
          notify(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            messageId,
            content: { type: 'text', text },
          }),
        );
        // Best-effort: if a delta (or completed step) mentions an image path that exists
        if (stepState === 'DONE') {
          const paths = extractImagePaths(text);
          emitImageAgentChunks(sessionId, state, paths, notifications);
        }
      }
      return { notifications, state };
    }

    if (stepType === 'tool') {
      const toolName = s.tool_name || s.tool_info?.name || 'tool';
      const toolCallId = `agy-tool-${stepIndex}`;
      const params = s.tool_info?.parameters;
      const output = s.tool_info?.output;
      const error = s.tool_info?.error;
      const kind = guessToolKind(toolName);
      const isTerminal = stepState === 'DONE' || stepState === 'ERROR';
      const failed = stepState === 'ERROR' || Boolean(error);

      if (stepState === 'ACTIVE' || !state.toolSeen.has(stepIndex)) {
        state.toolSeen.add(stepIndex);
        /** @type {Record<string, unknown>} */
        const update = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          title: toolName,
          kind,
          status: isTerminal ? (failed ? 'failed' : 'completed') : 'in_progress',
        };
        if (params !== undefined) update.rawInput = params;
        if (isTerminal) {
          const textOut = stringifyOut(output, error);
          const rich = buildRichToolContent(textOut, params, output, { toolName });
          if (rich.content.length) update.content = rich.content;
          if (output !== undefined) update.rawOutput = output;
          if (error !== undefined) update.rawError = error;
          emitImageAgentChunks(sessionId, state, rich.imagePaths, notifications);
        }
        notifications.push(notify(sessionId, update));
      } else if (isTerminal) {
        /** @type {Record<string, unknown>} */
        const update = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: failed ? 'failed' : 'completed',
        };
        const textOut = stringifyOut(output, error);
        const rich = buildRichToolContent(textOut, params, output, { toolName });
        if (rich.content.length) update.content = rich.content;
        if (output !== undefined) update.rawOutput = output;
        if (error !== undefined) update.rawError = error;
        notifications.push(notify(sessionId, update));
        emitImageAgentChunks(sessionId, state, rich.imagePaths, notifications);
      }
      return { notifications, state };
    }

    return { notifications, state };
  }

  if (event.event === 'result') {
    const r = event.result || {};
    if (r.conversation_id) state.conversationId = r.conversation_id;

    const usage = r.usage;
    if (usage && typeof usage.total_tokens === 'number') {
      notifications.push(
        notify(sessionId, {
          sessionUpdate: 'usage_update',
          used: usage.total_tokens,
          size: Math.max(200_000, usage.total_tokens),
        }),
      );
    }

    // Surface structured_output (e.g. from --json-schema) as a final JSON message chunk
    if (r.structured_output !== undefined && r.structured_output !== null) {
      let jsonText;
      try {
        jsonText =
          typeof r.structured_output === 'string'
            ? r.structured_output
            : JSON.stringify(r.structured_output, null, 2);
      } catch {
        jsonText = String(r.structured_output);
      }
      notifications.push(
        notify(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          messageId: `msg_agent_agy_structured_${Date.now()}`,
          content: {
            type: 'text',
            text: '```json\n' + jsonText + '\n```',
          },
          _meta: { structuredOutput: r.structured_output },
        }),
      );
    }

    // Surface image paths found in final response text
    if (r.response) {
      emitImageAgentChunks(sessionId, state, extractImagePaths(r.response), notifications);
    }

    const ok = r.status === 'SUCCESS';
    let stopReason = 'end_turn';
    if (!ok) {
      stopReason = r.status === 'REFUSAL' || /refus/i.test(String(r.error || '')) ? 'refusal' : 'end_turn';
      const errText = r.error || r.response || `agy result status: ${r.status}`;
      if (errText) {
        notifications.push(
          notify(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            messageId: `msg_agent_agy_error_${Date.now()}`,
            content: { type: 'text', text: String(errText) },
          }),
        );
      }
    }

    state.lastStopReason = stopReason;
    state.turnDone = true;
    notifications.push(
      notify(sessionId, {
        sessionUpdate: 'state_update',
        state: 'idle',
        stopReason,
      }),
    );
    return { notifications, state };
  }

  return { notifications, state };
}

/**
 * Flatten ACP ContentBlock[] into a single user string for agy (text-only, no staging).
 * Prefer normalizePromptBlocks from prompt-normalize.mjs for image/audio.
 * @param {unknown[]} blocks
 * @returns {{ text: string, notes: string[] }}
 */
export function promptBlocksToText(blocks: unknown): { text: string; notes: string[] } {
  const notes = [];
  const parts = [];
  if (!Array.isArray(blocks)) {
    return { text: '', notes: ['prompt was not an array'] };
  }
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const type = b.type;
    if (type === 'text' && typeof b.text === 'string') {
      parts.push(b.text);
    } else if (type === 'resource' && b.resource) {
      const r = b.resource;
      if (typeof r.text === 'string') {
        const uri = r.uri ? `[resource ${r.uri}]\n` : '[resource]\n';
        parts.push(uri + r.text);
      } else {
        notes.push(`skipped resource without text (${r.uri || 'unknown'})`);
      }
    } else if (type === 'resource_link') {
      notes.push(`skipped resource_link ${b.uri || ''}`);
      if (b.uri) parts.push(`[link: ${b.uri}]`);
    } else if (type === 'image' || type === 'audio') {
      notes.push(`skipped ${type} (use normalizePromptBlocks for staging)`);
    } else {
      notes.push(`skipped unsupported block type: ${type || typeof b}`);
    }
  }
  return { text: parts.join('\n\n'), notes };
}

/**
 * Build agy stream-json stdin user message line.
 * @param {string} text
 */
export function buildAgyUserMessage(text: string): Record<string, unknown> {
  return {
    event: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}
