import { describe, expect, test } from 'bun:test';
import {
  buildAgyArgs,
  extractLaunchConfig,
  applyConfigOption,
  normalizeJsonSchema,
  normalizeSandbox,
} from './agy-args.ts';

describe('buildAgyArgs', () => {
  test('first spawn omits --conversation', () => {
    const args = buildAgyArgs({ cwd: '/tmp/proj', skipPermissions: true });
    expect(args.includes('--conversation')).toBe(false);
    expect(args.includes('--dangerously-skip-permissions')).toBe(true);
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

  test('respawn includes --conversation', () => {
    const args = buildAgyArgs({
      cwd: '/tmp/proj',
      conversationId: 'conv-abc',
      skipPermissions: true,
    });
    expect(args[args.indexOf('--conversation') + 1]).toBe('conv-abc');
  });

  test('mapper.conversationId fallback', () => {
    const args = buildAgyArgs({
      cwd: '/tmp/proj',
      mapper: { conversationId: 'from-mapper' },
      skipPermissions: false,
    });
    expect(args.includes('--dangerously-skip-permissions')).toBe(false);
    expect(args[args.indexOf('--conversation') + 1]).toBe('from-mapper');
  });

  test('all launch flags', () => {
    const schema = '{"type":"object"}';
    const args = buildAgyArgs({
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
    });
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-flash');
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(args[args.indexOf('--mode') + 1]).toBe('plan');
    expect(args[args.indexOf('--agent') + 1]).toBe('default');
    expect(args.includes('--sandbox')).toBe(true);
    expect(args[args.indexOf('--json-schema') + 1]).toBe(schema);
    expect(args.includes('/extra')).toBe(true);
  });

  test('sandbox false omits flag', () => {
    const args = buildAgyArgs({ cwd: '/t', sandbox: false, skipPermissions: true });
    expect(args.includes('--sandbox')).toBe(false);
  });

  test('session.conversationId wins over mapper', () => {
    const args = buildAgyArgs({
      cwd: '/t',
      conversationId: 'sess',
      mapper: { conversationId: 'map' },
      skipPermissions: true,
    });
    expect(args[args.indexOf('--conversation') + 1]).toBe('sess');
  });
});

describe('extractLaunchConfig', () => {
  test('top-level preferred', () => {
    const cfg = extractLaunchConfig(
      { model: 'm1', effort: 'high', mode: 'accept-edits', agent: 'a', sandbox: true },
      {},
    );
    expect(cfg.model).toBe('m1');
    expect(cfg.effort).toBe('high');
    expect(cfg.mode).toBe('accept-edits');
    expect(cfg.agent).toBe('a');
    expect(cfg.sandbox).toBe(true);
  });

  test('_meta / config / env fallbacks', () => {
    const cfg = extractLaunchConfig(
      { _meta: { model: 'from-meta' }, config: { effort: 'medium' } },
      { AGY_ACP_MODE: 'plan', AGY_ACP_SANDBOX: '1', AGY_ACP_JSON_SCHEMA: '{"x":1}' },
    );
    expect(cfg.model).toBe('from-meta');
    expect(cfg.effort).toBe('medium');
    expect(cfg.mode).toBe('plan');
    expect(cfg.sandbox).toBe(true);
    expect(cfg.jsonSchema).toBe('{"x":1}');
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
      ],
    });
    expect(cfg.model).toBe('opt-model');
    expect(cfg.sandbox).toBe(true);
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
    const bad = applyConfigOption(session as never, 'nope', 'v');
    expect(bad.ok).toBe(false);
    expect(applyConfigOption(session as never, 'model', '').ok).toBe(true);
    expect(session.model).toBeUndefined();
  });
});
