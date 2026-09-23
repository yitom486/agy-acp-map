/**
 * Parse agy / jetski soft-deny signals from stderr and stream-json payloads.
 *
 * Observed stderr (2026-09):
 *   jetski: ... a tool required the "command" permission ... auto-denied.
 *   Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)).
 *
 * Also accepts explicit key=value fragments: tool=, allow-rule=, path=
 * And stream-json: tool ERROR with permission/denied wording + result.denied_actions
 *
 * Sandbox note: `agy --help` documents `--sandbox` only as "terminal restrictions
 * enabled". It does NOT state offline. Convention used here:
 * - model API + built-in search tools: assumed unaffected;
 * - terminal network (`curl`, `Invoke-WebRequest`, ...) may be blocked and is
 *   surfaced separately with `source: *-sandbox` so callers can suggest
 *   `safety: autonomous-unsandboxed` / `sandbox: false` retry.
 *
 * v0.1.3: do NOT treat generic tool ERROR as soft-deny (tighten parseSoftDenyFromEvent).
 */

export interface SoftDenyInfo {
  tool: string;
  allowRule: string;
  path?: string;
  source?: string;
}

/**
 * @param {string} stderrText
 * @returns {SoftDenyInfo[]}
 */
export function parseSoftDeny(stderrText: string): SoftDenyInfo[] {
  if (!stderrText || typeof stderrText !== 'string') return [];
  const found: SoftDenyInfo[] = [];
  const seen = new Set<string>();

  const push = (tool: string, allowRule: string, path?: string, source?: string) => {
    const t = String(tool || '').trim();
    const rule = String(allowRule || '').trim();
    if (!t && !rule) return;
    const key = `${t}|${rule}|${path || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    const item: SoftDenyInfo = {
      tool: t || guessToolFromRule(rule),
      allowRule: rule || defaultAllowRule(t),
      source: source || 'stderr',
    };
    if (path) item.path = path;
    found.push(item);
  };

  // Explicit key=value (documented / future-proof)
  const kvTool = [...stderrText.matchAll(/\btool\s*=\s*["']?([^\s"',;]+)["']?/gi)];
  const kvRule = [...stderrText.matchAll(/\ballow-rule\s*=\s*["']?([^\s"',;]+)["']?/gi)];
  const kvPath = [...stderrText.matchAll(/\bpath\s*=\s*["']?([^\s"',;]+)["']?/gi)];
  if (kvTool.length || kvRule.length) {
    const path = kvPath[0]?.[1];
    const n = Math.max(kvTool.length, kvRule.length);
    for (let i = 0; i < n; i++) {
      push(kvTool[i]?.[1] || '', kvRule[i]?.[1] || '', path, 'stderr-kv');
    }
  }

  // jetski: required the "command" permission
  for (const m of stderrText.matchAll(
    /required the\s+"([^"]+)"\s+permission[^\n]*auto-denied/gi,
  )) {
    const perm = m[1]!;
    const ctx = nearby(stderrText, m.index);
    const eg = /e\.g\.\s+([a-zA-Z_][\w]*(?:\(\s*<[^>]+>\s*\))?)/i.exec(m[0] + ' ' + ctx);
    const allowRule =
      eg?.[1] ||
      /allow-rule[^\n]*?\b([a-zA-Z_][\w]*\(\s*<[^>]+>\s*\))/i.exec(ctx)?.[1] ||
      `${perm}(<target>)`;
    push(permToTool(perm), allowRule, undefined, 'stderr-jetski');
  }

  // Broader: "Add an allow-rule ... (e.g. command(<target>))"
  for (const m of stderrText.matchAll(
    /allow-rule[^\n]*?\(e\.g\.\s+([a-zA-Z_][\w]*\(\s*<[^>]+>\s*\))\)/gi,
  )) {
    const rule = m[1]!;
    const toolName = rule.replace(/\(.*$/, '');
    push(permToTool(toolName), rule, undefined, 'stderr-eg');
  }

  // permission check failed ... "echo foo"
  for (const m of stderrText.matchAll(
    /permission check failed[^\n]*?(?:for\s+(?:unsandboxed\s+)?["']([^"']+)["'])?/gi,
  )) {
    const target = m[1];
    if (target) {
      push('run_command', `command(${JSON.stringify(target)})`, undefined, 'stderr-check');
    }
  }

  // sandbox / terminal-restriction blocks (distinct from permission allow-rules)
  for (const m of stderrText.matchAll(
    /sandbox[^\n]{0,200}?(blocked|restricted|denied|not allowed|network|terminal restriction)/gi,
  )) {
    void m;
    push('run_command', 'command(<target>)', undefined, 'stderr-sandbox');
    break;
  }
  for (const m of stderrText.matchAll(
    /terminal restriction[^\n]{0,200}?(blocked|restricted|denied|not allowed)/gi,
  )) {
    void m;
    push('run_command', 'command(<target>)', undefined, 'stderr-sandbox');
    break;
  }

  return found;
}

const PERMISSION_HINT =
  /permission|denied|auto-denied|allow-rule|not allowed|unauthorized|access denied/i;

const SANDBOX_HINT = /sandbox|terminal restriction|blocked by (sandbox|policy)|network.*(blocked|restricted|disabled)|EACCES|EPERM/i;

/**
 * Extract soft-denies from a single agy NDJSON event (tool ERROR / result.denied_actions).
 * Generic tool errors without permission wording are ignored (v0.1.3 tighten).
 */
export function parseSoftDenyFromEvent(event: unknown): SoftDenyInfo[] {
  const out: SoftDenyInfo[] = [];
  if (!event || typeof event !== 'object') return out;
  const ev = event as Record<string, unknown>;

  if (ev.event === 'step_update') {
    const s = (ev.step_update || {}) as Record<string, unknown>;
    if (s.step_type === 'tool' && (s.state === 'ERROR' || (s.tool_info as { error?: unknown })?.error)) {
      const toolInfo = (s.tool_info || {}) as Record<string, unknown>;
      const toolName = (s.tool_name as string) || (toolInfo.name as string) || 'tool';
      const err = toolInfo.error;
      const msg =
        typeof err === 'string'
          ? err
          : err && typeof err === 'object' && 'message' in err
            ? String((err as { message: unknown }).message)
            : err
              ? JSON.stringify(err)
              : '';
      // Tighten: require permission/denied wording — do NOT treat bare ERROR as soft-deny.
      // Sandbox blocks are reported separately so UI can suggest unsandboxed retry
      // instead of an allow-rule.
      if (PERMISSION_HINT.test(msg)) {
        const params = (toolInfo.parameters || {}) as Record<string, unknown>;
        const cmd =
          (params.CommandLine as string | undefined) ||
          (params.command as string | undefined) ||
          undefined;
        let allowRule = defaultAllowRule(toolName);
        if (toolName === 'run_command' || /command/i.test(toolName)) {
          allowRule = cmd ? `command(${JSON.stringify(cmd)})` : 'command(<target>)';
        }
        out.push({
          tool: toolName,
          allowRule,
          source: 'tool-error',
        });
      } else if (SANDBOX_HINT.test(msg)) {
        const params = (toolInfo.parameters || {}) as Record<string, unknown>;
        const cmd =
          (params.CommandLine as string | undefined) ||
          (params.command as string | undefined) ||
          undefined;
        out.push({
          tool: toolName,
          allowRule:
            toolName === 'run_command' || /command/i.test(toolName)
              ? cmd
                ? `command(${JSON.stringify(cmd)})`
                : 'command(<target>)'
              : defaultAllowRule(toolName),
          source: 'tool-sandbox',
        });
      }
    }
  }

  if (ev.event === 'result') {
    const result = (ev.result || {}) as Record<string, unknown>;
    const denied = result.denied_actions;
    if (Array.isArray(denied)) {
      for (const d of denied) {
        const item = d as { action?: string; display_name?: string };
        const action = item?.action || item?.display_name || 'unknown';
        const tool =
          action === 'command' || /RunCommand/i.test(String(item?.display_name || ''))
            ? 'run_command'
            : String(action);
        out.push({
          tool,
          allowRule: defaultAllowRule(tool),
          source: 'denied_actions',
        });
      }
    }
  }

  return out;
}

/**
 * Merge and de-dupe soft-deny lists.
 */
export function mergeSoftDenies(...lists: (SoftDenyInfo[] | undefined)[]): SoftDenyInfo[] {
  const seen = new Set<string>();
  const out: SoftDenyInfo[] = [];
  for (const list of lists) {
    for (const d of list || []) {
      const key = `${d.tool}|${d.allowRule}|${d.path || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

/**
 * Format soft-denies into a short agent-facing note.
 * Sandbox sources get a separate hint: built-in search is expected to keep
 * working, terminal network (`curl`, `Invoke-WebRequest`, ...) may be blocked —
 * retry the same prompt with `safety: autonomous-unsandboxed` / `sandbox: false`
 * to distinguish the two paths.
 */
export function formatSoftDenyMessage(denies: SoftDenyInfo[]): string {
  if (!denies?.length) return '';
  const lines = [
    'Headless soft-deny: one or more tools were auto-denied (no interactive permission UI).',
    'Suggested settings.json permissions.allow rules:',
  ];
  for (const d of denies) {
    const bits = [`- tool=${d.tool}`, `allow-rule=${d.allowRule}`];
    if (d.path) bits.push(`path=${d.path}`);
    if (d.source) bits.push(`(via ${d.source})`);
    lines.push(bits.join(' '));
  }
  lines.push(
    'Or set AGY_ACP_SAFETY=safe / AGY_ACP_SKIP_PERMISSIONS=0 to re-enable permission checks (autonomous-unsandboxed — full permissions, no sandbox — is the bridge default; AGY_ACP_SAFETY=autonomous re-enables sandbox containment).',
  );
  if (denies.some((d) => d.source?.includes('sandbox'))) {
    lines.push(
      'Sandbox note: --sandbox = terminal restrictions, not verified offline. Built-in search may still work; if `curl`/`Invoke-WebRequest` failed, retry once with safety=autonomous-unsandboxed (or sandbox:false) to confirm it is a sandbox network block.',
    );
  }
  return lines.join('\n');
}

function nearby(text: string, index: number | undefined, radius = 400) {
  const start = Math.max(0, (index || 0) - 80);
  return text.slice(start, (index || 0) + radius);
}

function permToTool(perm: string) {
  const p = String(perm || '').toLowerCase();
  if (p === 'command' || p === 'run_command') return 'run_command';
  if (p === 'write' || p === 'edit') return 'write_to_file';
  if (p === 'read') return 'view_file';
  return perm;
}

function guessToolFromRule(rule: string) {
  const name = String(rule || '').replace(/\(.*$/, '');
  return permToTool(name);
}

function defaultAllowRule(tool: string) {
  const t = String(tool || '').toLowerCase();
  if (t === 'run_command' || t === 'command') return 'command(<target>)';
  if (t) return `${t}(<target>)`;
  return 'command(<target>)';
}
