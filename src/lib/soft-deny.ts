/**
 * Parse agy / jetski soft-deny signals from stderr and stream-json payloads.
 *
 * Observed stderr (2026-09):
 *   jetski: ... a tool required the "command" permission ... auto-denied.
 *   Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)).
 *
 * Also accepts explicit key=value fragments: tool=, allow-rule=, path=
 * And stream-json: tool ERROR + result.denied_actions
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
  const found = [];
  const seen = new Set();

  const push = (tool, allowRule, path, source) => {
    const t = String(tool || '').trim();
    const rule = String(allowRule || '').trim();
    if (!t && !rule) return;
    const key = `${t}|${rule}|${path || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    /** @type {SoftDenyInfo} */
    const item = {
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
    const perm = m[1];
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
    const rule = m[1];
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

  return found;
}

/**
 * Extract soft-denies from a single agy NDJSON event (tool ERROR / result.denied_actions).
 * @param {object} event
 * @returns {SoftDenyInfo[]}
 */
export function parseSoftDenyFromEvent(event: unknown): SoftDenyInfo[] {
  const out = [];
  if (!event || typeof event !== 'object') return out;

  if (event.event === 'step_update') {
    const s = event.step_update || {};
    if (s.step_type === 'tool' && (s.state === 'ERROR' || s.tool_info?.error)) {
      const toolName = s.tool_name || s.tool_info?.name || 'tool';
      const err = s.tool_info?.error;
      const msg =
        typeof err === 'string'
          ? err
          : err?.message
            ? String(err.message)
            : err
              ? JSON.stringify(err)
              : '';
      if (/permission|denied|auto-denied/i.test(msg) || s.state === 'ERROR') {
        const cmd =
          s.tool_info?.parameters?.CommandLine ||
          s.tool_info?.parameters?.command ||
          undefined;
        let allowRule = defaultAllowRule(toolName);
        if (toolName === 'run_command' || /command/i.test(toolName)) {
          allowRule = cmd ? `command(${JSON.stringify(cmd)})` : 'command(<target>)';
        }
        out.push({
          tool: toolName,
          allowRule,
          source: 'tool-error',
          ...(typeof cmd === 'string' ? {} : {}),
        });
      }
    }
  }

  if (event.event === 'result') {
    const denied = event.result?.denied_actions;
    if (Array.isArray(denied)) {
      for (const d of denied) {
        const action = d?.action || d?.display_name || 'unknown';
        const tool =
          action === 'command' || /RunCommand/i.test(String(d?.display_name || ''))
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
 * @param {...SoftDenyInfo[]} lists
 */
export function mergeSoftDenies(...lists: (SoftDenyInfo[] | undefined)[]): SoftDenyInfo[] {
  const seen = new Set();
  const out = [];
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
 * @param {SoftDenyInfo[]} denies
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
    'Or set AGY_ACP_SKIP_PERMISSIONS=1 / pass --dangerously-skip-permissions (bridge default).',
  );
  return lines.join('\n');
}

function nearby(text, index, radius = 400) {
  const start = Math.max(0, (index || 0) - 80);
  return text.slice(start, (index || 0) + radius);
}

function permToTool(perm) {
  const p = String(perm || '').toLowerCase();
  if (p === 'command' || p === 'run_command') return 'run_command';
  if (p === 'write' || p === 'edit') return 'write_to_file';
  if (p === 'read') return 'view_file';
  return perm;
}

function guessToolFromRule(rule) {
  const name = String(rule || '').replace(/\(.*$/, '');
  return permToTool(name);
}

function defaultAllowRule(tool) {
  const t = String(tool || '').toLowerCase();
  if (t === 'run_command' || t === 'command') return 'command(<target>)';
  if (t) return `${t}(<target>)`;
  return 'command(<target>)';
}
