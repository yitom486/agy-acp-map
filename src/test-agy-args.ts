#!/usr/bin/env bun
/**
 * Unit tests for lib/agy-args.mjs (no live agy).
 */
import assert from 'node:assert/strict';
import {
  buildAgyArgs,
  extractLaunchConfig,
  applyConfigOption,
  normalizeJsonSchema,
  normalizeSandbox,
} from './lib/agy-args.ts';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
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
    mapper: { conversationId: 'from-mapper' },
    skipPermissions: false,
  });
  assert.ok(!args.includes('--dangerously-skip-permissions'));
  assert.equal(args[args.indexOf('--conversation') + 1], 'from-mapper');
});

check('all launch flags', () => {
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
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-flash');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--mode') + 1], 'plan');
  assert.equal(args[args.indexOf('--agent') + 1], 'default');
  assert.ok(args.includes('--sandbox'));
  assert.equal(args[args.indexOf('--json-schema') + 1], schema);
  assert.ok(args.includes('/extra'));
});

check('sandbox false omits flag', () => {
  const args = buildAgyArgs({ cwd: '/t', sandbox: false, skipPermissions: true });
  assert.ok(!args.includes('--sandbox'));
});

check('extractLaunchConfig: top-level preferred', () => {
  const cfg = extractLaunchConfig(
    { model: 'm1', effort: 'high', mode: 'accept-edits', agent: 'a', sandbox: true },
    {},
  );
  assert.equal(cfg.model, 'm1');
  assert.equal(cfg.effort, 'high');
  assert.equal(cfg.mode, 'accept-edits');
  assert.equal(cfg.agent, 'a');
  assert.equal(cfg.sandbox, true);
});

check('extractLaunchConfig: _meta / config / env fallbacks', () => {
  const cfg = extractLaunchConfig(
    { _meta: { model: 'from-meta' }, config: { effort: 'medium' } },
    { AGY_ACP_MODE: 'plan', AGY_ACP_SANDBOX: '1', AGY_ACP_JSON_SCHEMA: '{"x":1}' },
  );
  assert.equal(cfg.model, 'from-meta');
  assert.equal(cfg.effort, 'medium');
  assert.equal(cfg.mode, 'plan');
  assert.equal(cfg.sandbox, true);
  assert.equal(cfg.jsonSchema, '{"x":1}');
});

check('extractLaunchConfig: conversationId + jsonSchema object', () => {
  const cfg = extractLaunchConfig({
    conversationId: 'cid-9',
    jsonSchema: { type: 'object', properties: { word: { type: 'string' } } },
  });
  assert.equal(cfg.conversationId, 'cid-9');
  assert.ok(cfg.jsonSchema.includes('"type":"object"'));
});

check('extractLaunchConfig: configOptions', () => {
  const cfg = extractLaunchConfig({
    configOptions: [
      { id: 'model', value: 'opt-model' },
      { configId: 'sandbox', value: true },
    ],
  });
  assert.equal(cfg.model, 'opt-model');
  assert.equal(cfg.sandbox, true);
});

check('normalizeJsonSchema / sandbox helpers', () => {
  assert.equal(normalizeJsonSchema({ a: 1 }), '{"a":1}');
  assert.equal(normalizeJsonSchema('  hi  '), 'hi');
  assert.equal(normalizeJsonSchema(null), undefined);
  assert.equal(normalizeSandbox('1'), true);
  assert.equal(normalizeSandbox('0'), false);
  assert.equal(normalizeSandbox(undefined), undefined);
});

check('applyConfigOption mutates session', () => {
  const session = {};
  assert.equal(applyConfigOption(session, 'model', 'x').ok, true);
  assert.equal(session.model, 'x');
  assert.equal(applyConfigOption(session, 'sandbox', true).ok, true);
  assert.equal(session.sandbox, true);
  assert.equal(applyConfigOption(session, 'jsonSchema', { type: 'object' }).ok, true);
  assert.ok(session.jsonSchema);
  const bad = applyConfigOption(session, 'nope', 'v');
  assert.equal(bad.ok, false);
  assert.equal(applyConfigOption(session, 'model', '').ok, true);
  assert.equal(session.model, undefined);
});

check('session.conversationId wins over mapper', () => {
  const args = buildAgyArgs({
    cwd: '/t',
    conversationId: 'sess',
    mapper: { conversationId: 'map' },
    skipPermissions: true,
  });
  assert.equal(args[args.indexOf('--conversation') + 1], 'sess');
});

console.log(`---\n${passed} checks passed`);
if (process.exitCode) process.exit(process.exitCode);
