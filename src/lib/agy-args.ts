export type SafetyMode = 'safe' | 'autonomous' | 'autonomous-unsandboxed';

export interface LaunchConfig {
  model?: string;
  effort?: string;
  mode?: string;
  agent?: string;
  sandbox?: boolean;
  jsonSchema?: string;
  /** Prefer over raw skipPermissions when set. */
  safety?: SafetyMode;
  /** When true (default), pass --dangerously-skip-permissions. */
  skipPermissions?: boolean;
  /** When true (default), pass --disable-slash-commands. */
  disableSlashCommands?: boolean;
  /** Value for --print-timeout (e.g. "0", "30m", "120s"). Default "0". */
  printTimeout?: string;
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
  /** When set, buildAgyArgs may resolve skip/sandbox via resolveSafety unless explicit flags given. */
  safety?: SafetyMode;
  skipPermissions?: boolean;
  disableSlashCommands?: boolean;
  printTimeout?: string;
  stagingDirName?: string;
  stagingOutsideCwd?: string;
  mapper?: { conversationId?: string };
}

const CONFIG_IDS = new Set([
  'model',
  'effort',
  'mode',
  'agent',
  'sandbox',
  'jsonSchema',
  'printTimeout',
  'safety',
  'disableSlashCommands',
]);

/**
 * Pick first non-empty string from candidates.
 */
function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Normalize jsonSchema: object → JSON string; string kept as-is.
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
 * @returns undefined = not set
 */
export function normalizeSandbox(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no') return false;
  return Boolean(v);
}

/** Canonical safety tier values (also listed on BRIDGE_CAPABILITIES.safetyTiers). */
export const SAFETY_TIERS = ['safe', 'autonomous', 'autonomous-unsandboxed'] as const;

/** Legacy denominator kept only for unknown models (see modelContextWindow). */
export const DEFAULT_CONTEXT_SIZE = 200_000;

/**
 * Real input context window per model family, used as usage_update.size.
 *
 * Verified 2026-09: gemini-3.x flash = 1,048,576 input tokens;
 * claude sonnet-4-6 / opus-4-6 = 1,000,000; gpt-oss-120b = 131,072.
 * Unknown models fall back to DEFAULT_CONTEXT_SIZE (explicitly pessimistic).
 *
 * Override for any model via AGY_ACP_CONTEXT_SIZE (plain number, e.g. "1000000").
 */
export function modelContextWindow(
  model: unknown,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = normalizeContextSize(env.AGY_ACP_CONTEXT_SIZE);
  if (override !== undefined) return override;
  const m = typeof model === 'string' ? model.trim().toLowerCase() : '';
  if (!m) return DEFAULT_CONTEXT_SIZE;
  if (m.startsWith('gemini-3')) return 1_048_576;
  if (m.includes('sonnet-4-6') || m.includes('opus-4-6')) return 1_000_000;
  if (m.includes('gpt-oss-120b')) return 131_072;
  if (m.includes('claude')) return 200_000;
  return DEFAULT_CONTEXT_SIZE;
}

function normalizeContextSize(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(String(v).trim().replace(/_/g, ''));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * Normalize safety mode.
 * Accepts: safe | autonomous | auto | autonomous-unsandboxed | autonomous_unsandboxed | unsandboxed
 */
export function normalizeSafety(v: unknown): SafetyMode | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim().toLowerCase().replace(/_/g, '-');
  if (s === 'safe') return 'safe';
  if (s === 'autonomous' || s === 'auto') return 'autonomous';
  if (s === 'autonomous-unsandboxed' || s === 'unsandboxed') return 'autonomous-unsandboxed';
  return undefined;
}

/**
 * Normalize boolean-ish with default when unset.
 */
export function normalizeBool(v: unknown, defaultWhenUnset: boolean): boolean {
  if (v === undefined || v === null || v === '') return defaultWhenUnset;
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no') return false;
  return Boolean(v);
}

/**
 * Optional bool: undefined when unset.
 */
export function normalizeOptionalBool(v: unknown): boolean | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes') return true;
  if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no') return false;
  return Boolean(v);
}

/**
 * Normalize print-timeout string (pass-through; empty → undefined).
 */
export function normalizePrintTimeout(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

export interface ResolvedSafety {
  /** Resolved tier used for launch / logging. */
  safety: SafetyMode;
  /** Whether to pass --dangerously-skip-permissions. */
  skipPermissions: boolean;
  /** Whether to pass --sandbox (false → omit flag). */
  sandbox: boolean;
}

export type SafetyResolveInput = {
  safety?: SafetyMode | string;
  sandbox?: boolean;
  skipPermissions?: boolean;
};

/**
 * Central three-tier safety resolution.
 *
 * Note on `--sandbox`: agy documents it only as "terminal restrictions enabled".
 * It is NOT verified to mean offline. Assumed split:
 * - model API + built-in cloud search tools: unaffected;
 * - terminal network (`curl`, `Invoke-WebRequest`, `git clone`, `npm install`): may be blocked.
 * Use two probes to confirm: built-in search vs `run_command` network.
 *
 * Tiers:
 *   safe                        — no skip-permissions; sandbox only if explicitly true
 *   autonomous                  — skip-permissions; default --sandbox unless sandbox:false
 *                                 (opt-in containment; explicit safety/autonomous only)
 *   autonomous-unsandboxed      — skip-permissions; NEVER --sandbox (the default:
 *                                 full permissions, no terminal restrictions)
 *
 * Inputs:
 *   session.safety / AGY_ACP_SAFETY
 *   AGY_ACP_SKIP_PERMISSIONS=0 ≈ safe if safety unset; otherwise autonomous-unsandboxed
 *   explicit session.skipPermissions overrides the skip flag only
 *   explicit session.sandbox / AGY_ACP_SANDBOX override sandbox except when the
 *   unsandboxed tier was explicitly selected (defaulted tier honors opt-in)
 */
export function resolveSafety(
  session: SafetyResolveInput = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSafety {
  const explicitSafety =
    normalizeSafety(session.safety) ?? normalizeSafety(env.AGY_ACP_SAFETY) ?? undefined;
  let safety = explicitSafety;

  if (!safety) {
    const envSkip = env.AGY_ACP_SKIP_PERMISSIONS;
    if (envSkip !== undefined && envSkip !== '') {
      const skip = !(envSkip === '0' || envSkip === 'false' || envSkip === 'no');
      safety = skip ? 'autonomous-unsandboxed' : 'safe';
    } else {
      safety = 'autonomous-unsandboxed';
    }
  }

  let skipPermissions =
    safety === 'autonomous' || safety === 'autonomous-unsandboxed';
  if (session.skipPermissions !== undefined) {
    skipPermissions = Boolean(session.skipPermissions);
  }

  let sandbox: boolean;
  if (safety === 'autonomous-unsandboxed' && explicitSafety === 'autonomous-unsandboxed') {
    // Explicit dangerous tier: never pass --sandbox, even if asked.
    sandbox = false;
  } else if (session.sandbox !== undefined) {
    // Defaulted tier honors an explicit opt back into containment.
    sandbox = Boolean(session.sandbox);
  } else {
    const envSand = normalizeSandbox(env.AGY_ACP_SANDBOX);
    if (envSand !== undefined) {
      sandbox = envSand;
    } else if (safety === 'autonomous') {
      sandbox = true;
    } else {
      sandbox = false;
    }
  }

  return { safety, skipPermissions, sandbox };
}

/**
 * Resolve whether to pass --dangerously-skip-permissions (via resolveSafety).
 */
export function resolveSkipPermissions(
  session: SafetyResolveInput = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveSafety(session, env).skipPermissions;
}

/**
 * Resolve whether to pass --sandbox (via resolveSafety).
 * Returns true/false; callers that previously treated undefined as omit can use === true.
 */
export function resolveSandbox(
  session: SafetyResolveInput = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveSafety(session, env).sandbox;
}

/**
 * Resolve --disable-slash-commands (default true).
 * Disable via session.disableSlashCommands=false or AGY_ACP_DISABLE_SLASH_COMMANDS=0.
 */
export function resolveDisableSlashCommands(
  session: { disableSlashCommands?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (session.disableSlashCommands !== undefined) {
    return Boolean(session.disableSlashCommands);
  }
  const v = env.AGY_ACP_DISABLE_SLASH_COMMANDS;
  if (v !== undefined && v !== '') {
    return !(v === '0' || v === 'false' || v === 'no');
  }
  return true;
}

/**
 * Resolve --print-timeout value (default "0").
 */
export function resolvePrintTimeout(
  session: { printTimeout?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (session.printTimeout !== undefined && session.printTimeout !== '') {
    return String(session.printTimeout);
  }
  const fromEnv = normalizePrintTimeout(env.AGY_ACP_PRINT_TIMEOUT);
  if (fromEnv !== undefined) return fromEnv;
  return '0';
}

/**
 * Apply ACP-ish configOptions [{ id|configId, value }] onto a partial LaunchConfig.
 */
function applyConfigOptions(cfg: LaunchConfig, configOptions: unknown): void {
  if (!Array.isArray(configOptions)) return;
  for (const opt of configOptions) {
    if (!opt || typeof opt !== 'object') continue;
    const id = (opt as { id?: string; configId?: string }).id || (opt as { configId?: string }).configId;
    if (!id || !CONFIG_IDS.has(id)) continue;
    const value = (opt as { value?: unknown }).value;
    if (id === 'sandbox') {
      const s = normalizeSandbox(value);
      if (s !== undefined) cfg.sandbox = s;
    } else if (id === 'jsonSchema') {
      const j = normalizeJsonSchema(value);
      if (j !== undefined) cfg.jsonSchema = j;
    } else if (id === 'printTimeout') {
      const t = normalizePrintTimeout(value);
      if (t !== undefined) cfg.printTimeout = t;
    } else if (id === 'safety') {
      const s = normalizeSafety(value);
      if (s !== undefined) cfg.safety = s;
    } else if (id === 'disableSlashCommands') {
      const b = normalizeOptionalBool(value);
      if (b !== undefined) cfg.disableSlashCommands = b;
    } else if (typeof value === 'string' && value.trim()) {
      (cfg as Record<string, unknown>)[id] = value.trim();
    } else if (value != null && typeof value !== 'object') {
      (cfg as Record<string, unknown>)[id] = String(value);
    }
  }
}

/**
 * Resolve launch flags from session/new (or similar) params + env fallbacks.
 * Preferred fields: top-level, then _meta, then config, then configOptions, then env.
 */
export function extractLaunchConfig(
  params: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): LaunchConfigWithConversation {
  const p = params && typeof params === 'object' ? params : {};
  const meta = p._meta && typeof p._meta === 'object' ? (p._meta as Record<string, unknown>) : {};
  const config = p.config && typeof p.config === 'object' ? (p.config as Record<string, unknown>) : {};

  const out: LaunchConfigWithConversation = {};

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

  const safety =
    normalizeSafety(p.safety) ??
    normalizeSafety(meta.safety) ??
    normalizeSafety(config.safety) ??
    normalizeSafety(env.AGY_ACP_SAFETY);
  if (safety !== undefined) out.safety = safety;

  const skip =
    normalizeOptionalBool(p.skipPermissions) ??
    normalizeOptionalBool(meta.skipPermissions) ??
    normalizeOptionalBool(config.skipPermissions);
  if (skip !== undefined) out.skipPermissions = skip;

  const dsc =
    normalizeOptionalBool(p.disableSlashCommands) ??
    normalizeOptionalBool(meta.disableSlashCommands) ??
    normalizeOptionalBool(config.disableSlashCommands);
  if (dsc !== undefined) out.disableSlashCommands = dsc;

  const pt =
    normalizePrintTimeout(p.printTimeout) ??
    normalizePrintTimeout(meta.printTimeout) ??
    normalizePrintTimeout(config.printTimeout) ??
    normalizePrintTimeout(env.AGY_ACP_PRINT_TIMEOUT);
  if (pt !== undefined) out.printTimeout = pt;

  applyConfigOptions(out, p.configOptions);
  applyConfigOptions(out, meta.configOptions);

  out.conversationId = firstString(p.conversationId, meta.conversationId, config.conversationId);

  // Drop undefined keys for cleaner session storage
  for (const k of Object.keys(out)) {
    if ((out as Record<string, unknown>)[k] === undefined) delete (out as Record<string, unknown>)[k];
  }
  return out;
}

/**
 * Apply a single set_config_option onto session launch fields.
 */
export function applyConfigOption(
  session: SessionLaunchFields,
  configId: string,
  value: unknown,
): ApplyConfigResult {
  if (!CONFIG_IDS.has(configId)) {
    return {
      ok: false,
      error: `unsupported configId: ${configId} (want model|effort|mode|agent|sandbox|jsonSchema|printTimeout|safety|disableSlashCommands)`,
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
  if (configId === 'printTimeout') {
    if (value === null || value === '') {
      delete session.printTimeout;
      return { ok: true };
    }
    const t = normalizePrintTimeout(value);
    if (t === undefined) return { ok: false, error: 'invalid printTimeout' };
    session.printTimeout = t;
    return { ok: true };
  }
  if (configId === 'safety') {
    if (value === null || value === '') {
      delete session.safety;
      return { ok: true };
    }
    const s = normalizeSafety(value);
    if (s === undefined) return { ok: false, error: "safety must be 'safe' | 'autonomous' | 'autonomous-unsandboxed'" };
    session.safety = s;
    return { ok: true };
  }
  if (configId === 'disableSlashCommands') {
    if (value === null || value === '') {
      delete session.disableSlashCommands;
      return { ok: true };
    }
    const b = normalizeOptionalBool(value);
    if (b === undefined) return { ok: false, error: 'disableSlashCommands must be boolean' };
    session.disableSlashCommands = b;
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
 * When skipPermissions / sandbox are already resolved by the caller (spawnAgy),
 * they are used as-is. Otherwise resolveSafety(session) fills them from safety tier.
 *
 * Defaults:
 *   - safety: autonomous → skipPermissions true, sandbox true
 *   - disableSlashCommands: true
 *   - printTimeout: "0"
 */
export function buildAgyArgs(
  session: BuildAgyArgsSession,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  // resolveSafety owns skip + sandbox (incl. unsandboxed forcing no sandbox).
  const resolved = resolveSafety(
    {
      safety: session.safety,
      sandbox: session.sandbox,
      skipPermissions: session.skipPermissions,
    },
    env,
  );
  const skip = resolved.skipPermissions;
  const useSandbox = resolved.sandbox;

  const disableSlash =
    session.disableSlashCommands !== undefined
      ? Boolean(session.disableSlashCommands)
      : true;

  const printTimeout =
    session.printTimeout !== undefined && session.printTimeout !== ''
      ? String(session.printTimeout)
      : '0';

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

  if (disableSlash) {
    args.push('--disable-slash-commands');
  }

  args.push('--print-timeout', printTimeout, '--add-dir', session.cwd);

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

  const conv = session.conversationId || session.mapper?.conversationId || undefined;
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
  if (useSandbox) {
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
