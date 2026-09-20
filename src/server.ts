#!/usr/bin/env bun
/**
 * Minimal ACP v2 agent over stdio JSON-RPC 2.0 (one JSON object per line).
 * Bridges Google's agy CLI via official --input-format/--output-format stream-json.
 *
 * Mode: persistent stdin stream-json (spawn on first session/prompt).
 * Stdin line shape: {"event":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}
 *
 * Env:
 *   AGY_ACP_SKIP_PERMISSIONS=0|1  (default 0) — when 1, pass --dangerously-skip-permissions
 *   AGY_ACP_SAFETY=safe|autonomous  (default safe) — autonomous ⇒ skip permissions (+ sandbox if unset)
 *   AGY_ACP_DISABLE_SLASH_COMMANDS=0|1  (default 1) — pass --disable-slash-commands unless 0
 *   AGY_ACP_PRINT_TIMEOUT  (default 0) — pass --print-timeout <value>
 *   AGY_BIN — override agy binary (default "agy")
 *   AGY_ACP_MODEL / AGY_ACP_EFFORT / AGY_ACP_MODE / AGY_ACP_AGENT
 *   AGY_ACP_SANDBOX=1 / AGY_ACP_JSON_SCHEMA
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  createMapperState,
  resetTurnState,
  mapAgyEvent,
  buildAgyUserMessage,
} from './lib/map-agy-to-acp.ts';
import { normalizePromptBlocksSync, STAGING_DIRNAME } from './lib/prompt-normalize.ts';
import {
  parseSoftDeny,
  parseSoftDenyFromEvent,
  mergeSoftDenies,
  formatSoftDenyMessage,
} from './lib/soft-deny.ts';
import {
  extractLaunchConfig,
  applyConfigOption,
  buildAgyArgs,
  resolveSkipPermissions,
  resolveSandbox,
  resolveDisableSlashCommands,
  resolvePrintTimeout,
} from './lib/agy-args.ts';
import { discoverAgyCatalog } from './lib/agy-discovery.ts';

const AGENT_INFO = {
  name: 'agy-acp',
  title: 'agy ACP (stream-json)',
  version: '0.4.1',
};

const BRIDGE_CAPABILITIES = {
  prompt: true,
  streaming: true,
  tools: true,
  // conversationId persisted; respawn passes --conversation <id>
  resume: true,
  permissionRoundTrip: false,
  permissionMode: 'safe_default_or_autonomous',
  nativeCancel: false,
  cancelMode: 'SIGINT_then_KILL',
  historyReplay: 'adapter', // gateway must own transcript
  // Config at session/new; idle session/set_config_option updates fields → next prompt respawns
  dynamicConfig: 'restart',
  richContentInput: 'degrade_to_files', // images/resources → files + text refs
  richContentOutput: 'best_effort', // text + detect image paths from tools
  clientFilesystem: false,
  clientTerminal: false,
};

const AGY_BIN = process.env.AGY_BIN || 'agy';

/** Per-session: whether soft-deny scraping applies (i.e. not skipping permissions). */
function sessionSkipsPermissions(session) {
  return resolveSkipPermissions(session);
}

/** @type {Map<string, Session>} */
const sessions = new Map();

/**
 * @typedef {{
 *   sessionId: string,
 *   cwd: string,
 *   additionalDirectories?: string[],
 *   createdAt: string,
 *   updatedAt: string,
 *   title?: string,
 *   child: import('node:child_process').ChildProcess | null,
 *   mapper: ReturnType<typeof createMapperState>,
 *   busy: boolean,
 *   cancelled: boolean,
 *   protocolVersion: number,
 *   stderrBuf: string,
 *   softDenies: import('./lib/soft-deny.ts').SoftDenyInfo[],
 *   softDenyEmitted: boolean,
 *   conversationId?: string,
 *   model?: string,
 *   effort?: string,
 *   mode?: string,
 *   agent?: string,
 *   sandbox?: boolean,
 *   jsonSchema?: string,
 *   safety?: 'safe'|'autonomous',
 *   skipPermissions?: boolean,
 *   disableSlashCommands?: boolean,
 *   printTimeout?: string,
 * }} Session
 */

function writeMessage(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function reply(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  writeMessage({ jsonrpc: '2.0', id, error: err });
}

function notifyUpdate(sessionId, update) {
  writeMessage({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update },
  });
}

function ensurePath() {
  const extra = '/home/box/.local/bin';
  const p = process.env.PATH || '';
  if (!p.split(path.delimiter).includes(extra)) {
    process.env.PATH = `${extra}${path.delimiter}${p}`;
  }
}

/** Sync session.conversationId from mapper when learned. */
function syncConversationId(session) {
  const id = session.mapper?.conversationId;
  if (id && id !== session.conversationId) {
    session.conversationId = id;
  }
}

function sessionMeta(session) {
  /** @type {Record<string, unknown>} */
  const meta = {};
  if (session.conversationId) meta.conversationId = session.conversationId;
  if (session.model) meta.model = session.model;
  if (session.effort) meta.effort = session.effort;
  if (session.mode) meta.mode = session.mode;
  if (session.agent) meta.agent = session.agent;
  if (session.sandbox === true) meta.sandbox = true;
  if (session.jsonSchema) meta.jsonSchema = session.jsonSchema;
  if (session.safety) meta.safety = session.safety;
  if (session.printTimeout !== undefined) meta.printTimeout = session.printTimeout;
  if (session.disableSlashCommands !== undefined) {
    meta.disableSlashCommands = session.disableSlashCommands;
  }
  return Object.keys(meta).length ? meta : undefined;
}

function spawnAgy(session) {
  ensurePath();
  const skip = resolveSkipPermissions(session);
  const sandboxResolved = resolveSandbox(session);
  const disableSlash = resolveDisableSlashCommands(session);
  const printTimeout = resolvePrintTimeout(session);
  const args = buildAgyArgs({
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
    conversationId: session.conversationId || session.mapper?.conversationId,
    model: session.model,
    effort: session.effort,
    mode: session.mode,
    agent: session.agent,
    sandbox: sandboxResolved === true,
    jsonSchema: session.jsonSchema,
    skipPermissions: skip,
    disableSlashCommands: disableSlash,
    printTimeout,
  });

  // Staging dir lives under cwd; --add-dir cwd already covers it.
  const staging = path.join(session.cwd, STAGING_DIRNAME);
  if (!staging.startsWith(session.cwd)) {
    args.push('--add-dir', staging);
  }

  const conv = session.conversationId || session.mapper?.conversationId;
  const safetyLabel = session.safety || process.env.AGY_ACP_SAFETY || 'safe';
  process.stderr.write(
    `[agy-acp] spawn agy skipPermissions=${skip ? 1 : 0} safety=${safetyLabel} cwd=${session.cwd}` +
      `${conv ? ` conversation=${conv}` : ''}` +
      `${session.model ? ` model=${session.model}` : ''}` +
      `${session.effort ? ` effort=${session.effort}` : ''}` +
      `${session.mode ? ` mode=${session.mode}` : ''}` +
      `${session.agent ? ` agent=${session.agent}` : ''}` +
      `${sandboxResolved ? ' sandbox=1' : ''}` +
      `${disableSlash ? ' disableSlash=1' : ''}` +
      ` printTimeout=${printTimeout}` +
      `${session.jsonSchema ? ' jsonSchema=1' : ''}` +
      ` args=${JSON.stringify(args)}\n`,
  );

  const child = spawn(AGY_BIN, args, {
    cwd: session.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      process.stderr.write(`[agy-acp] bad ndjson: ${t.slice(0, 120)}\n`);
      return;
    }
    onAgyEvent(session, obj);
  });

  child.stderr.on('data', (buf) => {
    const s = buf.toString();
    session.stderrBuf = (session.stderrBuf || '') + s;
    for (const line of s.split('\n')) {
      if (line.trim()) process.stderr.write(`[agy stderr] ${line}\n`);
    }
  });

  child.on('exit', (code, signal) => {
    process.stderr.write(`[agy-acp] agy exited code=${code} signal=${signal}\n`);
    if (session.child === child) {
      session.child = null;
      if (session.busy) {
        maybeEmitSoftDeny(session);
        session.busy = false;
        const stopReason = session.cancelled ? 'cancelled' : 'end_turn';
        session.cancelled = false;
        notifyUpdate(session.sessionId, {
          sessionUpdate: 'state_update',
          state: 'idle',
          stopReason,
        });
      }
    }
  });

  session.child = child;
  return child;
}

function maybeEmitSoftDeny(session) {
  if (sessionSkipsPermissions(session)) return;
  const denies = mergeSoftDenies(session.softDenies, parseSoftDeny(session.stderrBuf || ''));
  emitSoftDenyUpdate(session, denies);
}

function emitSoftDenyUpdate(session, denies) {
  if (!denies?.length || session.softDenyEmitted) return;
  session.softDenyEmitted = true;
  notifyUpdate(session.sessionId, {
    sessionUpdate: 'agent_message_chunk',
    messageId: `msg_agent_soft_deny_${Date.now()}`,
    content: { type: 'text', text: formatSoftDenyMessage(denies) },
  });
}

function onAgyEvent(session, obj) {
  if (!sessionSkipsPermissions(session)) {
    const fromEv = parseSoftDenyFromEvent(obj);
    if (fromEv.length) {
      session.softDenies = mergeSoftDenies(session.softDenies, fromEv);
    }
  }

  const { notifications, state } = mapAgyEvent(session.sessionId, obj, session.mapper);
  session.mapper = state;
  syncConversationId(session);

  // Prefer emitting soft-deny before idle (from event-sourced denies).
  if (state.turnDone && !sessionSkipsPermissions(session)) {
    const fromStderr = parseSoftDeny(session.stderrBuf || '');
    const denies = mergeSoftDenies(session.softDenies, fromStderr);
    if (denies.length && !session.softDenyEmitted) {
      const soft = {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: `msg_agent_soft_deny_${Date.now()}`,
            content: { type: 'text', text: formatSoftDenyMessage(denies) },
          },
        },
      };
      session.softDenyEmitted = true;
      const idleIdx = notifications.findIndex(
        (n) => n.params?.update?.sessionUpdate === 'state_update' && n.params.update.state === 'idle',
      );
      if (idleIdx >= 0) notifications.splice(idleIdx, 0, soft);
      else notifications.push(soft);
    }
  }

  for (const n of notifications) {
    writeMessage(n);
  }

  if (state.turnDone) {
    // Late stderr may arrive after result; briefly wait then emit if needed.
    if (!sessionSkipsPermissions(session) && !session.softDenyEmitted) {
      const sid = session.sessionId;
      setTimeout(() => {
        const s = sessions.get(sid);
        if (!s || s.softDenyEmitted) return;
        const denies = mergeSoftDenies(s.softDenies, parseSoftDeny(s.stderrBuf || ''));
        if (denies.length) emitSoftDenyUpdate(s, denies);
      }, 600).unref?.();
    }
    session.busy = false;
    session.cancelled = false;
    session.updatedAt = new Date().toISOString();
  }
}

function killAgy(session) {
  if (!session.child) return;
  const child = session.child;
  try {
    child.kill('SIGINT');
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    if (session.child === child && !child.killed) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
  }, 2000).unref?.();
}

async function handleInitialize(id, params) {
  const requested = params?.protocolVersion;
  const protocolVersion = requested === 1 ? 1 : 2;

  const discovery = await discoverAgyCatalog({ timeoutMs: 10_000 });
  const availableModels = discovery.availableModels || [];
  const availableAgents = discovery.availableAgents || [];

  const bridgeCaps = {
    ...BRIDGE_CAPABILITIES,
    availableModels,
    availableAgents,
  };

  // ACP-ish configOptions catalog (models/agents as select lists when known)
  const configOptions = [];
  if (availableModels.length) {
    configOptions.push({
      id: 'model',
      name: 'Model',
      type: 'select',
      options: availableModels.map((m) => ({ value: m, name: m })),
    });
  } else {
    configOptions.push({ id: 'model', name: 'Model', type: 'string' });
  }
  if (availableAgents.length) {
    configOptions.push({
      id: 'agent',
      name: 'Agent',
      type: 'select',
      options: availableAgents.map((a) => ({ value: a, name: a })),
    });
  } else {
    configOptions.push({ id: 'agent', name: 'Agent', type: 'string' });
  }
  configOptions.push(
    {
      id: 'safety',
      name: 'Safety',
      type: 'select',
      options: [
        { value: 'safe', name: 'safe (default)' },
        { value: 'autonomous', name: 'autonomous' },
      ],
    },
    { id: 'effort', name: 'Effort', type: 'string' },
    { id: 'mode', name: 'Mode', type: 'string' },
    { id: 'sandbox', name: 'Sandbox', type: 'boolean' },
    { id: 'printTimeout', name: 'Print timeout', type: 'string' },
    { id: 'jsonSchema', name: 'JSON schema', type: 'string' },
    { id: 'disableSlashCommands', name: 'Disable slash commands', type: 'boolean' },
  );

  const common = {
    info: { ...AGENT_INFO },
    authMethods: [],
    bridgeCapabilities: bridgeCaps,
    configOptions,
    _meta: {
      bridgeCapabilities: bridgeCaps,
      availableModels,
      availableAgents,
      agyAcpSkipPermissionsDefault: 0,
      agyAcpSafetyDefault: 'safe',
      discoveryNotes: [
        ...(discovery.modelsError ? [`models: ${discovery.modelsError}`] : []),
        ...(discovery.agentsError ? [`agents: ${discovery.agentsError}`] : []),
      ],
      resumeNote: 'respawn passes --conversation <id> when conversationId known',
      dynamicConfigNote:
        'config at session/new; idle session/set_config_option → kill child; next prompt respawns with new flags + --conversation',
      safetyNote:
        'safe (default): no --dangerously-skip-permissions; soft-deny scrape enabled. autonomous: skip permissions; sandbox on if sandbox unset. Overrides: AGY_ACP_SKIP_PERMISSIONS, AGY_ACP_SANDBOX, session fields.',
    },
  };
  if (protocolVersion === 2) {
    reply(id, {
      protocolVersion: 2,
      capabilities: {
        session: {
          // Baseline ACP session surface; details in bridgeCapabilities
        },
      },
      ...common,
    });
  } else {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: false },
      agentInfo: { ...AGENT_INFO },
      capabilities: { session: {} },
      ...common,
    });
  }
}

function handleSessionNew(id, params) {
  const cwd = params?.cwd;
  if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    replyError(id, -32602, 'cwd must be an absolute path');
    return;
  }
  const launch = extractLaunchConfig(params);
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const mapper = createMapperState();
  if (launch.conversationId) {
    mapper.conversationId = launch.conversationId;
  }
  /** @type {Session} */
  const session = {
    sessionId,
    cwd,
    additionalDirectories: params?.additionalDirectories,
    createdAt: now,
    updatedAt: now,
    title: undefined,
    child: null,
    mapper,
    busy: false,
    cancelled: false,
    protocolVersion: 2,
    stderrBuf: '',
    softDenies: [],
    softDenyEmitted: false,
    conversationId: launch.conversationId,
    model: launch.model,
    effort: launch.effort,
    mode: launch.mode,
    agent: launch.agent,
    sandbox: launch.sandbox,
    jsonSchema: launch.jsonSchema,
    safety: launch.safety,
    skipPermissions: launch.skipPermissions,
    disableSlashCommands: launch.disableSlashCommands,
    printTimeout: launch.printTimeout,
  };
  sessions.set(sessionId, session);
  const meta = sessionMeta(session);
  reply(id, {
    sessionId,
    ...(meta ? { _meta: meta } : {}),
  });
}

function handleSessionList(id, params) {
  const filterCwd = params?.cwd;
  let list = [...sessions.values()];
  if (filterCwd) list = list.filter((s) => s.cwd === filterCwd);
  reply(id, {
    sessions: list.map((s) => {
      const meta = sessionMeta(s);
      return {
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title,
        updatedAt: s.updatedAt,
        ...(s.additionalDirectories?.length
          ? { additionalDirectories: s.additionalDirectories }
          : {}),
        ...(s.conversationId ? { conversationId: s.conversationId } : {}),
        ...(meta ? { _meta: meta } : {}),
      };
    }),
  });
}

function handleSessionClose(id, params) {
  const sessionId = params?.sessionId;
  const session = sessions.get(sessionId);
  if (!session) {
    replyError(id, -32001, `unknown sessionId: ${sessionId}`);
    return;
  }
  killAgy(session);
  sessions.delete(sessionId);
  reply(id, {});
}

function handleSessionResume(id, params) {
  const sessionId = params?.sessionId;
  const session = sessions.get(sessionId);
  if (!session) {
    replyError(id, -32001, `unknown sessionId: ${sessionId}`);
    return;
  }
  if (params?.cwd && params.cwd !== session.cwd) {
    replyError(id, -32602, 'cwd mismatch on resume (v0.3 does not relocate sessions)');
    return;
  }
  // historyReplay: adapter — no transcript replay here
  const meta = sessionMeta(session);
  reply(id, {
    sessionId,
    ...(meta ? { _meta: meta } : {}),
  });
}

/**
 * Idle-only: update launch config; kill lingering child so next prompt respawns.
 * params: { sessionId, configId, value }  (also accept id as alias of configId)
 */
function handleSessionSetConfigOption(id, params) {
  const sessionId = params?.sessionId;
  const session = sessions.get(sessionId);
  if (!session) {
    replyError(id, -32001, `unknown sessionId: ${sessionId}`);
    return;
  }
  if (session.busy) {
    replyError(id, -32002, 'session is busy; wait for idle before set_config_option');
    return;
  }
  const configId = params?.configId || params?.id;
  if (!configId || typeof configId !== 'string') {
    replyError(id, -32602, 'configId required (model|effort|mode|agent|sandbox|jsonSchema|printTimeout|safety|disableSlashCommands)');
    return;
  }
  const result = applyConfigOption(session, configId, params?.value);
  if (!result.ok) {
    replyError(id, -32602, result.error);
    return;
  }
  // Force respawn on next prompt with new flags (+ --conversation if known)
  if (session.child) {
    killAgy(session);
    session.child = null;
  }
  session.updatedAt = new Date().toISOString();
  const meta = sessionMeta(session);
  reply(id, {
    sessionId,
    configId,
    ...(meta ? { _meta: meta } : {}),
  });
}

async function handleSessionPrompt(id, params) {
  const sessionId = params?.sessionId;
  const session = sessions.get(sessionId);
  if (!session) {
    replyError(id, -32001, `unknown sessionId: ${sessionId}`);
    return;
  }
  if (session.busy) {
    replyError(id, -32002, 'session is busy; wait for idle or cancel');
    return;
  }

  // Optional mid-prompt restart hint (idle only — we already checked busy)
  const restartWith = params?._meta?.restartWith;
  if (restartWith && typeof restartWith === 'object') {
    const launch = extractLaunchConfig({ ...restartWith, cwd: session.cwd });
    if (launch.model !== undefined) session.model = launch.model;
    if (launch.effort !== undefined) session.effort = launch.effort;
    if (launch.mode !== undefined) session.mode = launch.mode;
    if (launch.agent !== undefined) session.agent = launch.agent;
    if (launch.sandbox !== undefined) session.sandbox = launch.sandbox;
    if (launch.jsonSchema !== undefined) session.jsonSchema = launch.jsonSchema;
    if (launch.safety !== undefined) session.safety = launch.safety;
    if (launch.skipPermissions !== undefined) session.skipPermissions = launch.skipPermissions;
    if (launch.disableSlashCommands !== undefined) {
      session.disableSlashCommands = launch.disableSlashCommands;
    }
    if (launch.printTimeout !== undefined) session.printTimeout = launch.printTimeout;
    if (session.child) {
      killAgy(session);
      session.child = null;
    }
  }

  const { text, notes, stagedFiles } = normalizePromptBlocksSync(params?.prompt || [], {
    cwd: session.cwd,
  });
  if (!text.trim()) {
    replyError(id, -32602, 'empty prompt after flattening content blocks', { notes });
    return;
  }

  const messageId = `msg_user_${randomUUID().slice(0, 8)}`;
  reply(id, { messageId });

  const content = [{ type: 'text', text }];
  notifyUpdate(sessionId, {
    sessionUpdate: 'user_message',
    messageId,
    content,
  });
  if (notes.length) {
    process.stderr.write(`[agy-acp] prompt notes: ${notes.join('; ')}\n`);
  }
  if (stagedFiles.length) {
    process.stderr.write(`[agy-acp] staged files: ${stagedFiles.join(', ')}\n`);
  }

  notifyUpdate(sessionId, {
    sessionUpdate: 'state_update',
    state: 'running',
  });

  if (!session.title) {
    session.title = text.slice(0, 80);
    notifyUpdate(sessionId, {
      sessionUpdate: 'session_info_update',
      title: session.title,
    });
  }

  session.busy = true;
  session.cancelled = false;
  session.stderrBuf = '';
  session.softDenies = [];
  session.softDenyEmitted = false;
  session.mapper = resetTurnState(session.mapper);
  session.updatedAt = new Date().toISOString();

  try {
    if (!session.child || session.child.killed || !session.child.stdin?.writable) {
      spawnAgy(session);
    }
    const line = JSON.stringify(buildAgyUserMessage(text));
    session.child.stdin.write(line + '\n');
  } catch (err) {
    session.busy = false;
    notifyUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: `msg_agent_agy_error_${Date.now()}`,
      content: { type: 'text', text: `failed to feed agy: ${err?.message || err}` },
    });
    notifyUpdate(sessionId, {
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'end_turn',
    });
  }
}

function handleSessionCancel(params) {
  const sessionId = params?.sessionId;
  const session = sessions.get(sessionId);
  if (!session) return;
  session.cancelled = true;
  if (session.child) {
    try {
      session.child.kill('SIGINT');
    } catch {
      /* ignore */
    }
  } else if (session.busy) {
    session.busy = false;
    notifyUpdate(sessionId, {
      sessionUpdate: 'state_update',
      state: 'idle',
      stopReason: 'cancelled',
    });
  }
}

async function dispatch(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;

  if (msg.method && msg.id === undefined) {
    if (msg.method === 'session/cancel') {
      handleSessionCancel(msg.params);
    }
    return;
  }

  const { id, method, params } = msg;
  if (!method) return;

  try {
    switch (method) {
      case 'initialize':
        await handleInitialize(id, params);
        break;
      case 'session/new':
        handleSessionNew(id, params);
        break;
      case 'session/list':
        handleSessionList(id, params);
        break;
      case 'session/close':
        handleSessionClose(id, params);
        break;
      case 'session/resume':
        handleSessionResume(id, params);
        break;
      case 'session/set_config_option':
        handleSessionSetConfigOption(id, params);
        break;
      case 'session/prompt':
        await handleSessionPrompt(id, params);
        break;
      default:
        replyError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    replyError(id, -32603, err?.message || String(err));
  }
}

export async function main() {
  ensurePath();
  const bootSkip = resolveSkipPermissions({});
  const bootSafety = process.env.AGY_ACP_SAFETY || 'safe';
  process.stderr.write(
    `[agy-acp] ${AGENT_INFO.name} ${AGENT_INFO.version} ready (stream-json stdin bridge) safety=${bootSafety} skipPermissions=${bootSkip ? 1 : 0}\n`,
  );

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (!t) continue;
    let msg;
    try {
      msg = JSON.parse(t);
    } catch {
      process.stderr.write(`[agy-acp] invalid json: ${t.slice(0, 80)}\n`);
      continue;
    }
    if (Array.isArray(msg)) {
      for (const m of msg) await dispatch(m);
    } else {
      await dispatch(msg);
    }
  }

  for (const s of sessions.values()) killAgy(s);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[agy-acp] fatal: ${err?.stack || err}\n`);
    process.exit(1);
  });
}
