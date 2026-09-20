#!/usr/bin/env bun
/**
 * Unit tests for lib/agy-args.ts (no live agy).
 */
import assert from 'node:assert/strict';
import {
  buildAgyArgs,
  extractLaunchConfig,
  applyConfigOption,
  normalizeJsonSchema,
  normalizeSandbox,
} from '../src/lib/agy-args.ts';

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err: any) {
    console.error(`FAIL ${name}:`, err.message);
    process.exitCode = 1;
  }
}

check('first spawn: no --conversation', () => {
  const args = buildAgyArgs({ cwd: '/tmp/proj', skipPermissions: true });
  assert.ok(!args.includes('--conversation'));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.deepEqual(
    args.slice(0, 6),
    ['-p', '', '--input-format', 'stream-json', '--output-format', 'stream-json'],
  );
  const addIdx = args.indexOf('--add-dir');
  assert.equal(args[addIdx + 1], '/tmp/proj');
});

check('respawn: --conversation when conversationId set', () => {
  const args = buildAgyArgs({
    cwd: '/tmp/proj',
    conversationId: 'conv-abc',
    skipPermissions: true,
  });
  const i = args.indexOf('--conversation');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'conv-abc');
});

check('mapper.conversationId fallback', () => {
  const args = buildAgyArgs({
    cwd: '/tmp/proj',
    mapper: { conversationId: 'conv-from-map' },
    skipPermissions: true,
  });
  const i = args.indexOf('--conversation');
  assert.ok(i >= 0);
  assert.equal(args[i + 1], 'conv-from-map');
});

check('session.conversationId wins over mapper', () => {
  const args = buildAgyArgs({
    cwd: '/tmp/proj',
    conversationId: 'conv-session',
    mapper: { conversationId: 'conv-mapper' },
    skipPermissions: true,
  });
  const i = args.indexOf('--conversation');
  assert.equal(args[i + 1], 'conv-session');
});

check('all launch flags passed through', () => {
  const args = buildAgyArgs({
    cwd: '/tmp/proj',
    model: 'gemini-2.5-flash',
    effort: 'high',
    mode: 'accept-edits',
    agent: 'coder',
    sandbox: true,
    jsonSchema: '{"type":"object"}',
    skipPermissions: true,
  });
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-2.5-flash');
  assert.ok(args.includes('--effort'));
  assert.equal(args[args.indexOf('--effort') + 1], 'high');
  assert.ok(args.includes('--mode'));
  assert.equal(args[args.indexOf('--mode') + 1], 'accept-edits');
  assert.ok(args.includes('--agent'));
  assert.equal(args[args.indexOf('--agent') + 1], 'coder');
  assert.ok(args.includes('--sandbox'));
  assert.ok(args.includes('--json-schema'));
  assert.equal(args[args.indexOf('--json-schema') + 1], '{"type":"object"}');
});

check('sandbox false omits flag', () => {
  const args = buildAgyArgs({ cwd: '/tmp/proj', sandbox: false, skipPermissions: true });
  assert.ok(!args.includes('--sandbox'));
});

check('extractLaunchConfig: preferred sources', () => {
  const cfg = extractLaunchConfig({
    model: 'top-model',
    _meta: { model: 'meta-model', effort: 'meta-effort' },
    config: { mode: 'cfg-mode' },
    sandbox: 'true',
  });
  assert.equal(cfg.model, 'top-model');
  assert.equal(cfg.effort, 'meta-effort');
  assert.equal(cfg.mode, 'cfg-mode');
  assert.equal(cfg.sandbox, true);
});

check('extractLaunchConfig: jsonSchema object normalized', () => {
  const cfg = extractLaunchConfig({
    jsonSchema: { type: 'string' },
  });
  assert.equal(cfg.jsonSchema, '{"type":"string"}');
});

check('extractLaunchConfig: configOptions applied', () => {
  const cfg = extractLaunchConfig({
    configOptions: [
      { id: 'model', value: 'opt-model' },
      { configId: 'effort', value: 'medium' },
      { id: 'sandbox', value: '1' },
      { id: 'unknown-id', value: 'ignored' },
    ],
  });
  assert.equal(cfg.model, 'opt-model');
  assert.equal(cfg.effort, 'medium');
  assert.equal(cfg.sandbox, true);
});

check('normalizeSandbox values', () => {
  assert.equal(normalizeSandbox(true), true);
  assert.equal(normalizeSandbox(false), false);
  assert.equal(normalizeSandbox(1), true);
  assert.equal(normalizeSandbox(0), false);
  assert.equal(normalizeSandbox('true'), true);
  assert.equal(normalizeSandbox('false'), false);
  assert.equal(normalizeSandbox('1'), true);
  assert.equal(normalizeSandbox('0'), false);
  assert.equal(normalizeSandbox(undefined), undefined);
  assert.equal(normalizeSandbox(''), undefined);
});

check('normalizeJsonSchema values', () => {
  assert.equal(normalizeJsonSchema('raw'), 'raw');
  assert.equal(normalizeJsonSchema({ a: 1 }), '{"a":1}');
  assert.equal(normalizeJsonSchema(''), undefined);
  assert.equal(normalizeJsonSchema(null), undefined);
});

check('applyConfigOption modifies session', () => {
  const session: any = {};
  assert.ok(applyConfigOption(session, 'model', 'new-model').ok);
  assert.equal(session.model, 'new-model');

  assert.ok(applyConfigOption(session, 'sandbox', 'true').ok);
  assert.equal(session.sandbox, true);

  assert.ok(applyConfigOption(session, 'jsonSchema', { x: 1 }).ok);
  assert.equal(session.jsonSchema, '{"x":1}');

  assert.ok(applyConfigOption(session, 'model', null).ok);
  assert.equal(session.model, undefined);

  assert.ok(!applyConfigOption(session, 'badKey', 'val').ok);
});

console.log(`\nAll ${passed} checks passed.`);
