import { describe, expect, test } from 'bun:test';
import {
  buildAgyArgs,
  extractLaunchConfig,
  applyConfigOption,
  normalizeJsonSchema,
  normalizeSandbox,
  normalizeSafety,
  resolveSafety,
  resolveSkipPermissions,
  resolveSandbox,
  resolveDisableSlashCommands,
  resolvePrintTimeout,
  SAFETY_TIERS,
} from './agy-args.ts';

describe('buildAgyArgs', () => {
  test('first spawn omits --conversation; safe defaults', () => {
    const args = buildAgyArgs({ cwd: '/tmp/proj' }, {});
    expect(args.includes('--conversation')).toBe(false);
    expect(args.includes('--dangerously-skip-permissions')).toBe(false);
    expect(args.includes('--sandbox')).toBe(false);
    expect(args.includes('--disable-slash-commands')).toBe(true);
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('0');
    expect(args.slice(0, 6)).toEqual([
      '-p',
      '',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
    ]);
    const addIdx = args.indexOf('--add-dir');
    expect(args[addIdx + 1]).toBe('/tmp/proj');
  });

  test('skipPermissions true adds flag; false omits', () => {
    const withSkip = buildAgyArgs({ cwd: '/tmp/proj', skipPermissions: true }, {});
    expect(withSkip.includes('--dangerously-skip-permissions')).toBe(true);
    const noSkip = buildAgyArgs({ cwd: '/tmp/proj', skipPermissions: false }, {});
    expect(noSkip.includes('--dangerously-skip-permissions')).toBe(false);
  });

  test('disableSlashCommands false omits flag', () => {
    const args = buildAgyArgs({ cwd: '/t', disableSlashCommands: false }, {});
    expect(args.includes('--disable-slash-commands')).toBe(false);
  });

  test('printTimeout custom value', () => {
    const args = buildAgyArgs({ cwd: '/t', printTimeout: '30m' }, {});
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('30m');
  });

  test('respawn includes --conversation', () => {
    const args = buildAgyArgs(
      {
        cwd: '/tmp/proj',
        conversationId: 'conv-abc',
        skipPermissions: true,
      },
      {},
    );
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-abc');
  });

  test('mapper.conversationId fallback', () => {
    const args = buildAgyArgs(
      {
        cwd: '/tmp/proj',
        mapper: { conversationId: 'from-mapper' },
        skipPermissions: false,
      },
      {},
    );
    expect(args.includes('--dangerously-skip-permissions')).toBe(false);
    expect(args[args.indexOf('--conversation') + 1]).toBe('from-mapper');
  });

  test('all launch flags', () => {
    const schema = '{"type":"object"}';
    const args = buildAgyArgs(
      {
        cwd: '/work',
        additionalDirectories: ['/extra'],
        conversationId: 'c1',
        model: 'gemini-flash',
        effort: 'low',
        mode: 'plan',
        agent: 'default',
        sandbox: true,
        jsonSchema: schema,
        skipPermissions: true,
        disableSlashCommands: true,
        printTimeout: '120s',
      },
      {},
    );
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-flash');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--agent') + 1]).toBe('default');
    expect(args.includes('--sandbox')).toBe(true);
    expect(args[args.indexOf('--json-schema') + 1]).toBe(schema);
    expect(args.includes('/extra')).toBe(true);
    expect(args.includes('--disable-slash-commands')).toBe(true);
    expect(args[args.indexOf('--print-timeout') + 1]).toBe('120s');
  });

  test('sandbox false omits flag', () => {
    const args = buildAgyArgs({ cwd: '/t', sandbox: false, skipPermissions: true }, {});
    expect(args.includes('--sandbox')).toBe(false);
  });

  test('session.conversationId wins over mapper', () => {
    const args = buildAgyArgs(
      {
        cwd: '/t',
        conversationId: 'sess',
        mapper: { conversationId: 'map' },
        skipPermissions: true,
      },
      {},
    );
    expect(args[args.indexOf('--conversation') + 1]).toBe('sess');
  });

  test('safety autonomous via buildAgyArgs adds skip + sandbox', () => {
    const args = buildAgyArgs({ cwd: '/t', safety: 'autonomous' }, {});
    expect(args.includes('--dangerously-skip-permissions')).toBe(true);
    expect(args.includes('--sandbox')).toBe(true);
  });

  test('safety autonomous-unsandboxed via buildAgyArgs: skip, no sandbox', () => {
    const args = buildAgyArgs(
      { cwd: '/t', safety: 'autonomous-unsandboxed', sandbox: true },
      {},
    );
    expect(args.includes('--dangerously-skip-permissions')).toBe(true);
    expect(args.includes('--sandbox')).toBe(false);
  });
});

describe('resolveSafety three tiers', () => {
  test('SAFETY_TIERS lists three canonical values', () => {
    expect(SAFETY_TIERS).toEqual(['safe', 'autonomous', 'autonomous-unsandboxed']);
  });

  test('safe (default): no skip, no sandbox', () => {
    expect(resolveSafety({}, {})).toEqual({
      safety: 'safe',
      skipPermissions: false,
      sandbox: false,
    });
    expect(resolveSafety({ safety: 'safe' }, {})).toEqual({
      safety: 'safe',
      skipPermissions: false,
      sandbox: false,
    });
  });

  test('safe: sandbox only when explicitly true', () => {
    expect(resolveSafety({ safety: 'safe', sandbox: true }, {}).sandbox).toBe(true);
    expect(resolveSafety({ safety: 'safe' }, { AGY_ACP_SANDBOX: '1' }).sandbox).toBe(true);
    expect(resolveSafety({ safety: 'safe', sandbox: false }, {}).sandbox).toBe(false);
  });

  test('autonomous: skip + default sandbox', () => {
    expect(resolveSafety({ safety: 'autonomous' }, {})).toEqual({
      safety: 'autonomous',
      skipPermissions: true,
      sandbox: true,
    });
    expect(resolveSafety({}, { AGY_ACP_SAFETY: 'autonomous' })).toEqual({
      safety: 'autonomous',
      skipPermissions: true,
      sandbox: true,
    });
  });

  test('autonomous: sandbox false when user explicitly disables', () => {
    expect(
      resolveSafety({ safety: 'autonomous', sandbox: false }, {}),
    ).toEqual({
      safety: 'autonomous',
      skipPermissions: true,
      sandbox: false,
    });
    expect(
      resolveSafety({ safety: 'autonomous' }, { AGY_ACP_SANDBOX: '0' }).sandbox,
    ).toBe(false);
  });

  test('autonomous-unsandboxed: skip, never sandbox', () => {
    expect(resolveSafety({ safety: 'autonomous-unsandboxed' }, {})).toEqual({
      safety: 'autonomous-unsandboxed',
      skipPermissions: true,
      sandbox: false,
    });
    // Even explicit sandbox:true is forced off
    expect(
      resolveSafety({ safety: 'autonomous-unsandboxed', sandbox: true }, {}),
    ).toEqual({
      safety: 'autonomous-unsandboxed',
      skipPermissions: true,
      sandbox: false,
    });
    expect(
      resolveSafety({}, { AGY_ACP_SAFETY: 'autonomous-unsandboxed', AGY_ACP_SANDBOX: '1' }),
    ).toEqual({
      safety: 'autonomous-unsandboxed',
      skipPermissions: true,
      sandbox: false,
    });
  });

  test('aliases: auto / unsandboxed / autonomous_unsandboxed', () => {
    expect(normalizeSafety('auto')).toBe('autonomous');
    expect(normalizeSafety('unsandboxed')).toBe('autonomous-unsandboxed');
    expect(normalizeSafety('autonomous_unsandboxed')).toBe('autonomous-unsandboxed');
    expect(normalizeSafety('autonomous-unsandboxed')).toBe('autonomous-unsandboxed');
    expect(resolveSafety({ safety: 'unsandboxed' as never }, {}).safety).toBe(
      'autonomous-unsandboxed',
    );
    expect(resolveSafety({}, { AGY_ACP_SAFETY: 'autonomous_unsandboxed' }).safety).toBe(
      'autonomous-unsandboxed',
    );
  });

  test('AGY_ACP_SKIP_PERMISSIONS≈autonomous/safe only when safety unset', () => {
    expect(resolveSafety({}, { AGY_ACP_SKIP_PERMISSIONS: '1' })).toEqual({
      safety: 'autonomous',
      skipPermissions: true,
      sandbox: true,
    });
    expect(resolveSafety({}, { AGY_ACP_SKIP_PERMISSIONS: '0' })).toEqual({
      safety: 'safe',
      skipPermissions: false,
      sandbox: false,
    });
    // Explicit safety wins over SKIP_PERMISSIONS env
    expect(
      resolveSafety({ safety: 'safe' }, { AGY_ACP_SKIP_PERMISSIONS: '1' }),
    ).toEqual({
      safety: 'safe',
      skipPermissions: false,
      sandbox: false,
    });
    expect(
      resolveSafety({ safety: 'autonomous' }, { AGY_ACP_SKIP_PERMISSIONS: '0' }),
    ).toEqual({
      safety: 'autonomous',
      skipPermissions: true,
      sandbox: true,
    });
  });

  test('explicit session.skipPermissions overrides skip flag only', () => {
    expect(
      resolveSafety({ safety: 'autonomous', skipPermissions: false }, {}),
    ).toEqual({
      safety: 'autonomous',
      skipPermissions: false,
      sandbox: true,
    });
    expect(
      resolveSafety({ safety: 'safe', skipPermissions: true }, {}),
    ).toEqual({
      safety: 'safe',
      skipPermissions: true,
      sandbox: false,
    });
  });

  test('resolveSkipPermissions / resolveSandbox wrappers', () => {
    expect(resolveSkipPermissions({}, {})).toBe(false);
    expect(resolveSkipPermissions({ safety: 'autonomous' }, {})).toBe(true);
    expect(resolveSkipPermissions({ safety: 'autonomous-unsandboxed' }, {})).toBe(true);
    expect(resolveSandbox({ safety: 'autonomous' }, {})).toBe(true);
    expect(resolveSandbox({ safety: 'safe' }, {})).toBe(false);
    expect(resolveSandbox({ safety: 'autonomous-unsandboxed' }, {})).toBe(false);
    expect(resolveSandbox({ safety: 'autonomous', sandbox: false }, {})).toBe(false);
  });

  test('disableSlashCommands default true; env 0 disables', () => {
    expect(resolveDisableSlashCommands({}, {})).toBe(true);
    expect(resolveDisableSlashCommands({ disableSlashCommands: false }, {})).toBe(false);
    expect(resolveDisableSlashCommands({}, { AGY_ACP_DISABLE_SLASH_COMMANDS: '0' })).toBe(false);
  });

  test('printTimeout default 0; env / session override', () => {
    expect(resolvePrintTimeout({}, {})).toBe('0');
    expect(resolvePrintTimeout({ printTimeout: '30m' }, {})).toBe('30m');
    expect(resolvePrintTimeout({}, { AGY_ACP_PRINT_TIMEOUT: '120s' })).toBe('120s');
  });

  test('normalizeSafety rejects unknown', () => {
    expect(normalizeSafety('safe')).toBe('safe');
    expect(normalizeSafety('autonomous')).toBe('autonomous');
    expect(normalizeSafety('nope')).toBeUndefined();
  });
});

describe('extractLaunchConfig', () => {
  test('top-level preferred', () => {
    const cfg = extractLaunchConfig(
      {
        model: 'm1',
        effort: 'high',
        mode: 'accept-edits',
        agent: 'a',
        sandbox: true,
        safety: 'autonomous',
        printTimeout: '30m',
        disableSlashCommands: false,
      },
      {},
    );
    expect(cfg.model).toBe('m1');
    expect(cfg.effort).toBe('high');
    expect(cfg.mode).toBe('accept-edits');
    expect(cfg.agent).toBe('a');
    expect(cfg.sandbox).toBe(true);
    expect(cfg.safety).toBe('autonomous');
    expect(cfg.printTimeout).toBe('30m');
    expect(cfg.disableSlashCommands).toBe(false);
  });

  test('extracts autonomous-unsandboxed', () => {
    const cfg = extractLaunchConfig({ safety: 'autonomous-unsandboxed' }, {});
    expect(cfg.safety).toBe('autonomous-unsandboxed');
    const cfg2 = extractLaunchConfig({}, { AGY_ACP_SAFETY: 'unsandboxed' });
    expect(cfg2.safety).toBe('autonomous-unsandboxed');
  });

  test('_meta / config / env fallbacks', () => {
    const cfg = extractLaunchConfig(
      { _meta: { model: 'from-meta' }, config: { effort: 'medium' } },
      {
        AGY_ACP_MODE: 'plan',
        AGY_ACP_SANDBOX: '1',
        AGY_ACP_JSON_SCHEMA: '{"x":1}',
        AGY_ACP_SAFETY: 'autonomous',
        AGY_ACP_PRINT_TIMEOUT: '0',
      },
    );
    expect(cfg.model).toBe('from-meta');
    expect(cfg.effort).toBe('medium');
    expect(cfg.mode).toBe('plan');
    expect(cfg.sandbox).toBe(true);
    expect(cfg.jsonSchema).toBe('{"x":1}');
    expect(cfg.safety).toBe('autonomous');
    expect(cfg.printTimeout).toBe('0');
  });

  test('conversationId + jsonSchema object', () => {
    const cfg = extractLaunchConfig({
      conversationId: 'cid-9',
      jsonSchema: { type: 'object', properties: { word: { type: 'string' } } },
    });
    expect(cfg.conversationId).toBe('cid-9');
    expect(cfg.jsonSchema?.includes('"type":"object"')).toBe(true);
  });

  test('configOptions', () => {
    const cfg = extractLaunchConfig({
      configOptions: [
        { id: 'model', value: 'opt-model' },
        { configId: 'sandbox', value: true },
        { id: 'printTimeout', value: '45s' },
        { id: 'safety', value: 'safe' },
      ],
    });
    expect(cfg.model).toBe('opt-model');
    expect(cfg.sandbox).toBe(true);
    expect(cfg.printTimeout).toBe('45s');
    expect(cfg.safety).toBe('safe');
  });
});

describe('helpers + applyConfigOption', () => {
  test('normalizeJsonSchema / sandbox', () => {
    expect(normalizeJsonSchema({ a: 1 })).toBe('{"a":1}');
    expect(normalizeJsonSchema('  hi  ')).toBe('hi');
    expect(normalizeJsonSchema(null)).toBeUndefined();
    expect(normalizeSandbox('1')).toBe(true);
    expect(normalizeSandbox('0')).toBe(false);
    expect(normalizeSandbox(undefined)).toBeUndefined();
  });

  test('applyConfigOption mutates session', () => {
    const session: Record<string, unknown> = {};
    expect(applyConfigOption(session as never, 'model', 'x').ok).toBe(true);
    expect(session.model).toBe('x');
    expect(applyConfigOption(session as never, 'sandbox', true).ok).toBe(true);
    expect(session.sandbox).toBe(true);
    expect(applyConfigOption(session as never, 'jsonSchema', { type: 'object' }).ok).toBe(true);
    expect(session.jsonSchema).toBeTruthy();
    expect(applyConfigOption(session as never, 'printTimeout', '30m').ok).toBe(true);
    expect(session.printTimeout).toBe('30m');
    expect(applyConfigOption(session as never, 'safety', 'autonomous').ok).toBe(true);
    expect(session.safety).toBe('autonomous');
    expect(applyConfigOption(session as never, 'safety', 'autonomous-unsandboxed').ok).toBe(
      true,
    );
    expect(session.safety).toBe('autonomous-unsandboxed');
    expect(applyConfigOption(session as never, 'safety', 'unsandboxed').ok).toBe(true);
    expect(session.safety).toBe('autonomous-unsandboxed');
    expect(applyConfigOption(session as never, 'disableSlashCommands', false).ok).toBe(true);
    expect(session.disableSlashCommands).toBe(false);
    const bad = applyConfigOption(session as never, 'nope', 'v');
    expect(bad.ok).toBe(false);
    const badSafety = applyConfigOption(session as never, 'safety', 'nope');
    expect(badSafety.ok).toBe(false);
    expect(applyConfigOption(session as never, 'model', '').ok).toBe(true);
    expect(session.model).toBeUndefined();
  });
});
