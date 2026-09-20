export interface LaunchConfig {
  model?: string;
  effort?: string;
  mode?: string;
  agent?: string;
  sandbox?: boolean;
  jsonSchema?: string;
}

export interface LaunchConfigWithConversation extends LaunchConfig {
  conversationId?: string;
}

export interface SessionLaunchFields extends LaunchConfig {
  conversationId?: string;
  [key: string]: unknown;
}

export type ApplyConfigResult = { ok: true } | { ok: false; error: string };

export interface BuildAgyArgsSession {
  cwd: string;
  additionalDirectories?: string[];
  conversationId?: string;
  model?: string;
  effort?: string;
  mode?: string;
  agent?: string;
  sandbox?: boolean;
  jsonSchema?: string;
  skipPermissions?: boolean;
  stagingDirName?: string;
  stagingOutsideCwd?: string;
  mapper?: { conversationId?: string };
}

const CONFIG_IDS = new Set(['model', 'effort', 'mode', 'agent', 'sandbox', 'jsonSchema']);

/**
 * Pick first non-empty string from candidates.
 * @param {...unknown} vals
 * @returns {string|undefined}
 */
function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Normalize jsonSchema: object → JSON string; string kept as-is.
 * @param {unknown} v
 * @returns {string|undefined}
 */
export function normalizeJsonSchema(v: unknown): string | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'string') {
    const t = v.trim();
    return t || undefined;
  }
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Truthy sandbox from boolean / string / number.
 * @param {unknown} v
 * @returns {boolean|undefined} undefined = not set
 */
export function normalizeSandbox(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no') return false;
  return Boolean(v);
}

/**
 * Apply ACP-ish configOptions [{ id|configId, value }] onto a partial LaunchConfig.
 * @param {LaunchConfig} cfg
 * @param {unknown} configOptions
 */
function applyConfigOptions(cfg, configOptions) {
  if (!Array.isArray(configOptions)) return;
  for (const opt of configOptions) {
    if (!opt || typeof opt !== 'object') continue;
    const id = opt.id || opt.configId;
    if (!CONFIG_IDS.has(id)) continue;
    const value = opt.value;
    if (id === 'sandbox') {
      const s = normalizeSandbox(value);
      if (s !== undefined) cfg.sandbox = s;
    } else if (id === 'jsonSchema') {
      const j = normalizeJsonSchema(value);
      if (j !== undefined) cfg.jsonSchema = j;
    } else if (typeof value === 'string' && value.trim()) {
      cfg[id] = value.trim();
    } else if (value != null && typeof value !== 'object') {
      cfg[id] = String(value);
    }
  }
}

/**
 * Resolve launch flags from session/new (or similar) params + env fallbacks.
 * Preferred fields: top-level, then _meta, then config, then configOptions, then env.
 *
 * @param {Record<string, unknown>|null|undefined} params
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {LaunchConfig & { conversationId?: string }}
 */
export function extractLaunchConfig(params: Record<string, unknown> | null | undefined, env: NodeJS.ProcessEnv = process.env): LaunchConfigWithConversation {
  const p = params && typeof params === 'object' ? params : {};
  const meta = p._meta && typeof p._meta === 'object' ? p._meta : {};
  const config = p.config && typeof p.config === 'object' ? p.config : {};

  /** @type {LaunchConfig & { conversationId?: string }} */
  const out = {};

  out.model = firstString(p.model, meta.model, config.model, env.AGY_ACP_MODEL);
  out.effort = firstString(p.effort, meta.effort, config.effort, env.AGY_ACP_EFFORT);
  out.mode = firstString(p.mode, meta.mode, config.mode, env.AGY_ACP_MODE);
  out.agent = firstString(p.agent, meta.agent, config.agent, env.AGY_ACP_AGENT);

  const sand =
    normalizeSandbox(p.sandbox) ??
    normalizeSandbox(meta.sandbox) ??
    normalizeSandbox(config.sandbox) ??
    normalizeSandbox(env.AGY_ACP_SANDBOX);
  if (sand !== undefined) out.sandbox = sand;

  const js =
    normalizeJsonSchema(p.jsonSchema) ??
    normalizeJsonSchema(meta.jsonSchema) ??
    normalizeJsonSchema(config.jsonSchema) ??
    normalizeJsonSchema(env.AGY_ACP_JSON_SCHEMA);
  if (js !== undefined) out.jsonSchema = js;

  applyConfigOptions(out, p.configOptions);
  applyConfigOptions(out, meta.configOptions);

  out.conversationId = firstString(
    p.conversationId,
    meta.conversationId,
    config.conversationId,
  );

  // Drop undefined keys for cleaner session storage
  for (const k of Object.keys(out)) {
    if (out[k] === undefined) delete out[k];
  }
  return out;
}

/**
 * Apply a single set_config_option onto session launch fields.
 * @param {object} session — mutated
 * @param {string} configId
 * @param {unknown} value
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function applyConfigOption(session: SessionLaunchFields, configId: string, value: unknown): ApplyConfigResult {
  if (!CONFIG_IDS.has(configId)) {
    return {
      ok: false,
      error: `unsupported configId: ${configId} (want model|effort|mode|agent|sandbox|jsonSchema)`,
    };
  }
  if (configId === 'sandbox') {
    const s = normalizeSandbox(value);
    if (s === undefined) return { ok: false, error: 'sandbox value required' };
    session.sandbox = s;
    return { ok: true };
  }
  if (configId === 'jsonSchema') {
    if (value === null || value === '') {
      delete session.jsonSchema;
      return { ok: true };
    }
    const j = normalizeJsonSchema(value);
    if (j === undefined) return { ok: false, error: 'invalid jsonSchema' };
    session.jsonSchema = j;
    return { ok: true };
  }
  if (value === null || value === '') {
    delete session[configId];
    return { ok: true };
  }
  if (typeof value !== 'string' || !value.trim()) {
    return { ok: false, error: `${configId} must be a non-empty string` };
  }
  session[configId] = value.trim();
  return { ok: true };
}

/**
 * Build argv for `agy` (without the binary name).
 *
 * @param {{
 *   cwd: string,
 *   additionalDirectories?: string[],
 *   conversationId?: string,
 *   model?: string,
 *   effort?: string,
 *   mode?: string,
 *   agent?: string,
 *   sandbox?: boolean,
 *   jsonSchema?: string,
 *   skipPermissions?: boolean,
 *   stagingDirName?: string,
 * }} session
 * @returns {string[]}
 */
export function buildAgyArgs(session: BuildAgyArgsSession): string[] {
  const skip =
    session.skipPermissions !== undefined
      ? Boolean(session.skipPermissions)
      : true;

  const args = [
    '-p',
    '',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ];

  if (skip) {
    args.push('--dangerously-skip-permissions');
  }

  args.push('--print-timeout', '0', '--add-dir', session.cwd);

  const stagingName = session.stagingDirName || '.agy-acp-staging';
  // Staging under cwd is covered by --add-dir cwd; keep hook for tests.
  if (session.stagingOutsideCwd) {
    args.push('--add-dir', session.stagingOutsideCwd);
  }

  if (Array.isArray(session.additionalDirectories)) {
    for (const d of session.additionalDirectories) {
      if (d) args.push('--add-dir', d);
    }
  }

  const conv =
    session.conversationId ||
    session.mapper?.conversationId ||
    undefined;
  if (conv) {
    args.push('--conversation', String(conv));
  }

  if (session.model) {
    args.push('--model', String(session.model));
  }
  if (session.effort) {
    args.push('--effort', String(session.effort));
  }
  if (session.mode) {
    args.push('--mode', String(session.mode));
  }
  if (session.agent) {
    args.push('--agent', String(session.agent));
  }
  if (session.sandbox === true) {
    args.push('--sandbox');
  }
  if (session.jsonSchema) {
    args.push('--json-schema', String(session.jsonSchema));
  }

  // silence unused stagingName in production path
  void stagingName;

  return args;
}

export { CONFIG_IDS };
