/**
 * Pure-ish mapping: agy stream-json NDJSON events → ACP v2 session/update notifications.
 * Image inlining uses fs via rich-content.ts (best-effort). Offline map.mjs still works.
 */
import {
  buildRichToolContent,
  extractImagePaths,
  fileToAcpImageBlock,
  type FileToAcpImageOpts,
} from './rich-content.ts';
import path from 'node:path';
import { STAGING_DIRNAME } from './prompt-normalize.ts';

export interface MapperState {
  conversationId?: string;
  tools?: string[];
  permissionMode?: string;
  agentMessageIds: Map<number, string>;
  thoughtMessageIds?: Map<number, string>;
  toolSeen: Set<number>;
  /** Stable per-turn toolCallIds: stepIndex -> id (prevents cross-turn merge in Zed). */
  toolIds: Map<number, string>;
  /** Monotonic turn counter; part of toolCallId so step_index reuse never collides. */
  turnSeq: number;
  lastStopReason?: string;
  turnDone?: boolean;
  emittedImageUris: Set<string>;
  /** True when at least one agent_response text_delta was emitted this turn. */
  emittedTextDelta?: boolean;
  /** True when at least one agent_response thought_delta was emitted this turn. */
  emittedThoughtDelta?: boolean;
  /** Session roots for image allowlist (set by server). */
  richRoots?: FileToAcpImageOpts;
}

export interface AcpNotification {
  jsonrpc: '2.0';
  method: string;
  params: Record<string, unknown>;
}

export function createMapperState(richRoots?: FileToAcpImageOpts): MapperState {
  return {
    conversationId: undefined,
    tools: undefined,
    permissionMode: undefined,
    agentMessageIds: new Map(),
    thoughtMessageIds: new Map(),
    toolSeen: new Set(),
    toolIds: new Map(),
    turnSeq: 0,
    lastStopReason: undefined,
    turnDone: false,
    emittedImageUris: new Set(),
    emittedTextDelta: false,
    emittedThoughtDelta: false,
    richRoots,
  };
}

/** Reset per-turn tracking (keep conversationId / tools / richRoots / turnSeq+1). */
export function resetTurnState(state: MapperState): MapperState {
  return {
    ...state,
    agentMessageIds: new Map(),
    thoughtMessageIds: new Map(),
    toolSeen: new Set(),
    toolIds: new Map(),
    turnSeq: (state.turnSeq ?? 0) + 1,
    lastStopReason: undefined,
    turnDone: false,
    emittedImageUris: new Set(),
    emittedTextDelta: false,
    emittedThoughtDelta: false,
  };
}

/** Stable unique toolCallId per turn+step. Native agents use UUIDs; agy reuses step_index. */
function toolCallIdForStep(state: MapperState, stepIndex: number): string {
  const existing = state.toolIds.get(stepIndex);
  if (existing) return existing;
  const id = `agy-t${state.turnSeq ?? 0}-s${stepIndex}`;
  state.toolIds.set(stepIndex, id);
  return id;
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

function notify(sessionId: string, update: Record<string, unknown>) {
  return {
    jsonrpc: '2.0' as const,
    method: 'session/update',
    params: { sessionId, update },
  };
}

function agentMessageIdForStep(state: MapperState, stepIndex: number) {
  if (!state.agentMessageIds.has(stepIndex)) {
    state.agentMessageIds.set(stepIndex, `msg_agent_agy_${stepIndex}`);
  }
  return state.agentMessageIds.get(stepIndex)!;
}

function agentThoughtIdForStep(state: MapperState, stepIndex: number) {
  if (!state.thoughtMessageIds) state.thoughtMessageIds = new Map();
  if (!state.thoughtMessageIds.has(stepIndex)) {
    state.thoughtMessageIds.set(stepIndex, `msg_thought_agy_${stepIndex}`);
  }
  return state.thoughtMessageIds.get(stepIndex)!;
}

function humanizeToolName(name: string): string {
  return String(name || 'tool')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function commandPreview(params: unknown, maxLen = 80): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as Record<string, unknown>;
  const raw =
    (p.CommandLine as unknown) ?? (p.command as unknown) ?? (p.cmd as unknown) ??
    (p.script as unknown) ?? (p.code as unknown);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const oneLine = raw.trim().replace(/\s+/g, ' ');
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen - 1) + '…' : oneLine;
}

function filePreview(params: unknown): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as Record<string, unknown>;
  const raw =
    (p.path as unknown) ?? (p.file as unknown) ?? (p.filePath as unknown) ??
    (p.filename as unknown) ?? (p.uri as unknown);
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const t = raw.trim();
  return t.length > 80 ? '…' + t.slice(-79) : t;
}

/** Human-readable title so Zed never renders a lonely `run_command` card. */
function toolTitle(toolName: string, params: unknown): string {
  const cmd = commandPreview(params);
  if (cmd) {
    const base = /run_command|command/i.test(toolName) ? 'Run' : humanizeToolName(toolName);
    return `${base}: ${cmd}`;
  }
  const file = filePreview(params);
  if (file) {
    const n = toolName.toLowerCase();
    const verb = n.includes('write') || n.includes('edit') || n.includes('replace') ? 'Edit' : 'Read';
    return `${verb}: ${file}`;
  }
  return humanizeToolName(toolName);
}

/** Immediate preview content for ACTIVE tools — avoids blank in_progress cards. */
function toolPreviewContent(toolName: string, params: unknown): { type: 'content'; content: { type: 'text'; text: string } } | null {
  const cmd = commandPreview(params);
  if (cmd) return { type: 'content', content: { type: 'text', text: `$ ${cmd}` } };
  const file = filePreview(params);
  if (file) return { type: 'content', content: { type: 'text', text: file } };
  return null;
}

function linePreview(params: unknown): number | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const p = params as Record<string, unknown>;
  const raw =
    (p.line as unknown) ?? (p.line_number as unknown) ?? (p.lineNumber as unknown) ??
    (p.start_line as unknown) ?? (p.startLine as unknown) ?? (p.lineno as unknown);
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : (raw as number);
  if (Number.isInteger(n) && (n as number) >= 0) return n as number;
  return undefined;
}

/** File locations for follow-along (view/edit tools). Zed uses this to jump to files. */
function toolLocations(toolName: string, params: unknown): { path: string; line?: number }[] | undefined {
  const file = filePreview(params);
  if (!file) return undefined;
  const n = toolName.toLowerCase();
  if (
    n.includes('view') || n.includes('read') || n.includes('write') ||
    n.includes('edit') || n.includes('replace') || n === 'list_dir'
  ) {
    if (/^[A-Za-z]:[\\/]|^\/|^\\\\/.test(file) || !file.includes(' ')) {
      const line = linePreview(params);
      return line !== undefined ? [{ path: file, line }] : [{ path: file }];
    }
  }
  return undefined;
}

function extractThought(s: Record<string, unknown>): string | undefined {
  const candidates = [
    s.thought_delta,
    (s.agent_response as any)?.thought_delta,
    (s as any).thought,
    (s as any).reasoning,
    (s as any).thinking,
    (s as any).reasoning_delta,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return undefined;
}

/** Format or adapt updates according to client ACP protocol version (v1 vs v2). */
export function formatUpdateForProtocol(
  update: Record<string, unknown>,
  protocolVersion: number,
): Record<string, unknown> | null {
  if (protocolVersion >= 2) {
    // In ACP v2, tool creation and update are unified under tool_call_update (upsert semantics)
    if (update.sessionUpdate === 'tool_call') {
      return {
        ...update,
        sessionUpdate: 'tool_call_update',
      };
    }
    return update;
  }

  // Protocol v1 formatting:
  // In v1, state_update does not exist; return null so it is not emitted.
  if (update.sessionUpdate === 'state_update') {
    return null;
  }

  // In v1, user_message is not part of the SessionUpdate union and prompt echoes are not expected;
  // return null so it is not emitted.
  if (update.sessionUpdate === 'user_message') {
    return null;
  }

  // ACP v1 natively supports agent_thought_chunk, tool_call, tool_call_update, agent_message_chunk.
  // Preserving them allows clients like Zed to show thoughts and tool states natively.
  return update;
}

function stringifyOut(output: unknown, error: unknown) {
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

function imageOpts(state: MapperState): FileToAcpImageOpts {
  return state.richRoots || {};
}

function emitImageAgentChunks(
  sessionId: string,
  state: MapperState,
  paths: string[],
  notifications: AcpNotification[],
) {
  const opts = imageOpts(state);
  for (const p of paths) {
    const img = fileToAcpImageBlock(p, opts);
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

function mapStopReason(status: unknown, error: unknown): string {
  const s = String(status || '').toUpperCase();
  if (s === 'CANCELLED' || s === 'CANCELED' || s === 'INTERRUPTED' || s === 'ABORT' || s === 'ABORTED') {
    return 'cancelled';
  }
  if (s === 'REFUSAL' || /refus/i.test(String(error || ''))) {
    return 'refusal';
  }
  if (s === 'SUCCESS' || s === 'OK' || s === '') {
    return 'end_turn';
  }
  // Unknown non-success → still idle end_turn (error text may be emitted separately)
  return 'end_turn';
}

/**
 * Map one agy NDJSON event object into zero or more ACP session/update notifications.
 */
export function mapAgyEvent(
  sessionId: string,
  event: unknown,
  state: MapperState,
): { notifications: AcpNotification[]; state: MapperState } {
  const notifications: AcpNotification[] = [];
  if (!event || typeof event !== 'object') {
    return { notifications, state };
  }
  const ev = event as Record<string, unknown>;
  if (!state.emittedImageUris) state.emittedImageUris = new Set();

  if (ev.event === 'init') {
    state.conversationId = (ev.conversation_id as string) || state.conversationId;
    const init = (ev.init || {}) as Record<string, unknown>;
    state.tools = init.tools as string[] | undefined;
    state.permissionMode = init.permission_mode as string | undefined;
    return { notifications, state };
  }

  if (ev.event === 'step_update') {
    const s = (ev.step_update || {}) as Record<string, unknown>;
    const stepIndex = s.step_index as number;
    const stepType = s.step_type;
    const stepState = s.state; // ACTIVE | DONE | ERROR | ...

    if (stepType === 'user_input') {
      return { notifications, state };
    }

    if (stepType === 'agent_response') {
      const text = s.text_delta;
      if (typeof text === 'string' && text.length > 0) {
        state.emittedTextDelta = true;
        const messageId = agentMessageIdForStep(state, stepIndex);
        notifications.push(
          notify(sessionId, {
            sessionUpdate: 'agent_message_chunk',
            messageId,
            content: { type: 'text', text },
          }),
        );
        if (stepState === 'DONE') {
          const paths = extractImagePaths(text);
          emitImageAgentChunks(sessionId, state, paths, notifications);
        }
      }

      const thought = extractThought(s);
      if (typeof thought === 'string' && thought.length > 0) {
        state.emittedThoughtDelta = true;
        const messageId = agentThoughtIdForStep(state, stepIndex);
        notifications.push(
          notify(sessionId, {
            sessionUpdate: 'agent_thought_chunk',
            messageId,
            content: { type: 'text', text: thought },
          }),
        );
      }

      return { notifications, state };
    }

    if (stepType === 'tool') {
      const toolInfo = (s.tool_info || {}) as Record<string, unknown>;
      const toolName = (s.tool_name as string) || (toolInfo.name as string) || 'tool';
      const toolCallId = toolCallIdForStep(state, stepIndex);
      const params = toolInfo.parameters;
      const output = toolInfo.output;
      const error = toolInfo.error;
      const kind = guessToolKind(toolName);
      const isTerminal = stepState === 'DONE' || stepState === 'ERROR';
      const failed = stepState === 'ERROR' || Boolean(error);
      const richOpts = { ...imageOpts(state), toolName };

      if (!state.toolSeen.has(stepIndex)) {
        state.toolSeen.add(stepIndex);
        const status = isTerminal ? (failed ? 'failed' : 'completed') : 'in_progress';
        const title = toolTitle(toolName, params);
        const locations = toolLocations(toolName, params);
        const toolCall: Record<string, unknown> = {
          sessionUpdate: 'tool_call',
          toolCallId,
          title,
          name: toolName,
          kind,
          status,
        };
        if (params !== undefined) toolCall.rawInput = params;
        if (locations) toolCall.locations = locations;

        if (isTerminal) {
          const textOut = stringifyOut(output, error);
          const rich = buildRichToolContent(textOut, params, output, richOpts);
          if (rich.content.length) toolCall.content = rich.content;
          if (output !== undefined) toolCall.rawOutput = output;
          if (error !== undefined) toolCall.rawError = error;
          notifications.push(notify(sessionId, toolCall));
          emitImageAgentChunks(sessionId, state, rich.imagePaths, notifications);
        } else {
          // ACTIVE preview: never leave Zed with a blank card while the tool runs.
          const preview = toolPreviewContent(toolName, params);
          if (preview) toolCall.content = [preview];
          notifications.push(notify(sessionId, toolCall));
        }
      } else if (isTerminal) {
        const title = toolTitle(toolName, params);
        const locations = toolLocations(toolName, params);
        const update: Record<string, unknown> = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          title,
          name: toolName,
          status: failed ? 'failed' : 'completed',
        };
        if (locations) update.locations = locations;
        const textOut = stringifyOut(output, error);
        const rich = buildRichToolContent(textOut, params, output, richOpts);
        if (rich.content.length) update.content = rich.content;
        if (output !== undefined) update.rawOutput = output;
        if (error !== undefined) update.rawError = error;
        notifications.push(notify(sessionId, update));
        emitImageAgentChunks(sessionId, state, rich.imagePaths, notifications);
      } else {
        // Duplicate ACTIVE (heartbeat): refresh title/preview so UI doesn't look stuck.
        const update: Record<string, unknown> = {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          title: toolTitle(toolName, params),
          name: toolName,
          status: 'in_progress',
        };
        const preview = toolPreviewContent(toolName, params);
        if (preview) update.content = [preview];
        notifications.push(notify(sessionId, update));
      }
      return { notifications, state };
    }

    return { notifications, state };
  }

  if (ev.event === 'result') {
    const r = (ev.result || {}) as Record<string, unknown>;
    if (r.conversation_id) state.conversationId = r.conversation_id as string;

    const usage = r.usage as { total_tokens?: number } | undefined;
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
      let jsonText: string;
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

    // P1: result.response fallback when no text_delta was streamed this turn
    const responseText =
      typeof r.response === 'string'
        ? r.response
        : r.response != null
          ? String(r.response)
          : '';
    if (!state.emittedTextDelta && responseText && String(r.status || '').toUpperCase() === 'SUCCESS') {
      notifications.push(
        notify(sessionId, {
          sessionUpdate: 'agent_message_chunk',
          messageId: `msg_agent_agy_response_${Date.now()}`,
          content: { type: 'text', text: responseText },
          _meta: { fromResultResponse: true },
        }),
      );
      state.emittedTextDelta = true;
    }

    // Surface image paths found in final response text
    if (r.response) {
      emitImageAgentChunks(sessionId, state, extractImagePaths(r.response), notifications);
    }

    const statusStr = String(r.status || '').toUpperCase();
    const ok = statusStr === 'SUCCESS';
    let stopReason = mapStopReason(r.status, r.error);
    if (!ok && stopReason !== 'cancelled' && stopReason !== 'refusal') {
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
 */
export function promptBlocksToText(blocks: unknown): { text: string; notes: string[] } {
  const notes: string[] = [];
  const parts: string[] = [];
  if (!Array.isArray(blocks)) {
    return { text: '', notes: ['prompt was not an array'] };
  }
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const type = (b as { type?: string }).type;
    if (type === 'text' && typeof (b as { text?: string }).text === 'string') {
      parts.push((b as { text: string }).text);
    } else if (type === 'resource' && (b as { resource?: unknown }).resource) {
      const r = (b as { resource: Record<string, unknown> }).resource;
      if (typeof r.text === 'string') {
        const uri = r.uri ? `[resource ${r.uri}]\n` : '[resource]\n';
        parts.push(uri + r.text);
      } else {
        notes.push(`skipped resource without text (${r.uri || 'unknown'})`);
      }
    } else if (type === 'resource_link') {
      notes.push(`skipped resource_link ${(b as { uri?: string }).uri || ''}`);
      if ((b as { uri?: string }).uri) parts.push(`[link: ${(b as { uri: string }).uri}]`);
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

/** Helper for server: build richRoots from session fields. */
export function richRootsFromSession(session: {
  cwd: string;
  additionalDirectories?: string[];
}): FileToAcpImageOpts {
  return {
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
    stagingDir: path.join(session.cwd, STAGING_DIRNAME),
  };
}
