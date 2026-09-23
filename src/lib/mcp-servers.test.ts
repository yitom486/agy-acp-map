import { describe, test, expect } from 'bun:test';
import {
  validateMcpServers,
  normalizeMcpServer,
  mcpServerToAgyAddArgs,
  syncMcpServers,
  removeMcpServers,
  type McpRunFn,
} from './mcp-servers.ts';

const okRun: McpRunFn = async () => ({ status: 0, stdout: 'ok', stderr: '' });

describe('mcp-servers mapping (ACP -> agy mcp add)', () => {
  test('stdio maps command/args/env with flags before the name and -- after it', () => {
    const [s] = validateMcpServers([
      {
        name: 'lumina',
        command: 'node',
        args: ['server.js', '--port', '3801'],
        env: [{ name: 'PORT', value: '3801' }],
      },
    ]);
    expect(mcpServerToAgyAddArgs(s)).toEqual([
      'mcp',
      'add',
      '--env',
      'PORT=3801',
      'lumina',
      '--',
      'node',
      'server.js',
      '--port',
      '3801',
    ]);
  });

  test('http maps url/headers with explicit --type http before the name', () => {
    const [s] = validateMcpServers([
      {
        name: 'web',
        type: 'http',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer T' }],
      },
    ]);
    expect(mcpServerToAgyAddArgs(s)).toEqual([
      'mcp',
      'add',
      '--header',
      'Authorization: Bearer T',
      '--type',
      'http',
      'web',
      'https://example.com/mcp',
    ]);
  });

  test('typeless url-only entry resolves to http', () => {
    const [s] = validateMcpServers([{ name: 'w', url: 'http://localhost:3000/x' }]);
    expect(s.kind).toBe('http');
  });

  test('malformed entries fail fast (no silent tools-less session)', () => {
    expect(() => validateMcpServers('nope' as any)).toThrow(/must be an array/);
    expect(() => validateMcpServers([null] as any)).toThrow(/must be an object/);
    expect(() => validateMcpServers([{ command: 'x' }] as any)).toThrow(/name must be/);
    expect(() => validateMcpServers([{ name: 'bad name' }] as any)).toThrow(/no whitespace/);
    expect(() => validateMcpServers([{ name: 'x' }] as any)).toThrow(/needs a command/);
    expect(() => validateMcpServers([{ name: 'x', command: 'y', url: 'http://z' }] as any)).toThrow(
      /ambiguous/,
    );
    expect(() =>
      validateMcpServers([
        { name: 'a', command: 'x' },
        { name: 'a', command: 'y' },
      ]),
    ).toThrow(/duplicate name/);
    expect(() => validateMcpServers([{ name: 'x', command: 'y', args: 'z' }] as any)).toThrow(
      /args/,
    );
  });

  test('sse/acp transports are rejected loudly (agy has no equivalent)', () => {
    expect(() =>
      normalizeMcpServer({ name: 's', type: 'sse', url: 'http://x/sse' }),
    ).toThrow(/no 'agy mcp add' equivalent/);
    expect(() =>
      normalizeMcpServer({ name: 'a', type: 'acp', command: 'x' }),
    ).toThrow(/no 'agy mcp add' equivalent/);
  });

  test('sync success returns added names; failure throws with server + log', async () => {
    const [s] = validateMcpServers([{ name: 'lumina', command: 'node' }]);
    // Stateful stub emulating agy: list reflects prior adds.
    const registered = new Set<string>();
    const stateful: McpRunFn = async (_bin, args) => {
      if (args[1] === 'list') {
        return { status: 0, stdout: [...registered].join('\n'), stderr: '' };
      }
      registered.add('lumina');
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const res = await syncMcpServers('agy', [s], stateful);
    expect(res).toEqual({ added: ['lumina'] });

    const bad: McpRunFn = async () => ({ status: 1, stdout: '', stderr: 'boom' });
    await expect(syncMcpServers('agy', [s], bad)).rejects.toThrow(/failed to register MCP server 'lumina'.*boom/);

    const threw: McpRunFn = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(syncMcpServers('agy', [s], threw)).rejects.toThrow(/spawn ENOENT/);
  });

  test('sync verifies via list: exit-0-but-absent throws loud', async () => {
    const [s] = validateMcpServers([{ name: 'ghost', command: 'node' }]);
    // add exits 0 yet list stays empty (agy swallowing --version-style args).
    const lying: McpRunFn = async (_bin, args) => {
      if (args[1] === 'list') return { status: 0, stdout: 'No MCP servers configured.', stderr: '' };
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    await expect(syncMcpServers('agy', [s], lying)).rejects.toThrow(
      /absent from 'mcp list'/,
    );
  });

  test('remove is best-effort: warnings, never throws', async () => {
    const calls: string[][] = [];
    const flaky: McpRunFn = async (_bin, args) => {
      calls.push(args);
      if (args.includes('gone')) return { status: 1, stdout: '', stderr: 'not found' };
      return { status: 0, stdout: 'ok', stderr: '' };
    };
    const res = await removeMcpServers('agy', ['lumina', 'gone'], flaky);
    expect(res.removed).toEqual(['lumina']);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('gone');
    expect(calls).toEqual([
      ['mcp', 'remove', 'lumina'],
      ['mcp', 'remove', 'gone'],
    ]);
  });
});
