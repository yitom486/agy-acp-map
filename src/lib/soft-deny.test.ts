import { describe, expect, test } from 'bun:test';
import {
  parseSoftDeny,
  parseSoftDenyFromEvent,
  mergeSoftDenies,
  formatSoftDenyMessage,
} from './soft-deny.ts';

describe('parseSoftDeny', () => {
  test('empty / non-string → []', () => {
    expect(parseSoftDeny('')).toEqual([]);
    expect(parseSoftDeny(null as never)).toEqual([]);
  });

  test('jetski auto-denied stderr', () => {
    const stderr =
      'jetski: a tool required the "command" permission for target echo hi and was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)).';
    const got = parseSoftDeny(stderr);
    expect(got.length).toBeGreaterThan(0);
    expect(got.some((d) => d.tool === 'run_command' || d.allowRule.includes('command'))).toBe(true);
  });

  test('explicit key=value', () => {
    const got = parseSoftDeny('tool=run_command allow-rule=command("ls") path=/tmp');
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]!.tool).toBe('run_command');
    expect(got[0]!.allowRule).toContain('command');
  });
});

describe('parseSoftDenyFromEvent', () => {
  test('tool ERROR with permission message', () => {
    const got = parseSoftDenyFromEvent({
      event: 'step_update',
      step_update: {
        step_type: 'tool',
        state: 'ERROR',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          error: 'permission denied: auto-denied',
          parameters: { CommandLine: 'echo hi' },
        },
      },
    });
    expect(got.length).toBeGreaterThan(0);
    expect(got[0]!.tool).toBe('run_command');
  });

  test('generic tool ERROR without permission wording is NOT soft-deny', () => {
    const got = parseSoftDenyFromEvent({
      event: 'step_update',
      step_update: {
        step_type: 'tool',
        state: 'ERROR',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          error: 'command failed with exit code 1: file not found',
          parameters: { CommandLine: 'cat missing' },
        },
      },
    });
    expect(got.length).toBe(0);
  });

  test('result.denied_actions', () => {
    const got = parseSoftDenyFromEvent({
      event: 'result',
      result: {
        denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
      },
    });
    expect(got.length).toBe(1);
    expect(got[0]!.tool).toBe('run_command');
  });
});

describe('merge + format', () => {
  test('mergeSoftDenies dedupes', () => {
    const a = [{ tool: 't', allowRule: 'r', source: 'a' }];
    const b = [{ tool: 't', allowRule: 'r', source: 'b' }, { tool: 'u', allowRule: 'v' }];
    const m = mergeSoftDenies(a, b);
    expect(m.length).toBe(2);
  });

  test('formatSoftDenyMessage', () => {
    const msg = formatSoftDenyMessage([
      { tool: 'run_command', allowRule: 'command(<target>)', source: 'stderr' },
    ]);
    expect(msg).toContain('allow-rule=command(<target>)');
    expect(msg).toContain('tool=run_command');
  });
});
