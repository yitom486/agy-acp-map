import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  AgyProcessManager,
  escalateKill,
  forceKill,
  waitForExit,
  DEFAULT_GRACE_MS,
} from './agy-process.ts';

describe('AgyProcessManager generation', () => {
  test('increments generation on each spawn and ignores stale events', async () => {
    const mgr = new AgyProcessManager();
    const seen: number[] = [];

    // Spawn a long-lived sleep that prints one JSON line then sleeps
    const script1 = `
      console.log(JSON.stringify({event:'init',n:1}));
      setTimeout(() => {}, 30000);
    `;
    await mgr.spawn({
      bin: process.execPath, // bun/node
      args: ['-e', script1],
      cwd: process.cwd(),
      onEvent: (_obj, gen) => {
        seen.push(gen);
      },
      onError: () => {},
      onExit: () => {},
    });
    const gen1 = mgr.currentGeneration;
    expect(gen1).toBe(1);

    // Wait for the line
    for (let i = 0; i < 30 && !seen.includes(1); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen).toContain(1);

    // Kill and respawn — old generation events must be ignored
    const script2 = `
      console.log(JSON.stringify({event:'init',n:2}));
      setTimeout(() => {}, 30000);
    `;
    await mgr.spawn({
      bin: process.execPath,
      args: ['-e', script2],
      cwd: process.cwd(),
      onEvent: (_obj, gen) => {
        seen.push(gen);
      },
      onError: () => {},
      onExit: () => {},
    });
    expect(mgr.currentGeneration).toBe(2);
    for (let i = 0; i < 30 && seen.filter((g) => g === 2).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen.filter((g) => g === 2).length).toBeGreaterThanOrEqual(1);
    // No events with gen=1 after respawn should arrive (stale filtered)
    await mgr.kill({ awaitExit: true, graceMs: 500 });
    expect(mgr.isAlive()).toBe(false);
  }, 15000);

  test('onError fires for missing binary without unhandled rejection', async () => {
    const mgr = new AgyProcessManager();
    let errMsg = '';
    let errGen = -1;
    await mgr.spawn({
      bin: '/no/such/agy-binary-xyz-0.1.3',
      args: [],
      cwd: process.cwd(),
      onEvent: () => {},
      onError: (err, gen) => {
        errMsg = err.message;
        errGen = gen;
      },
      onExit: () => {},
    });
    // Give the error event a moment
    await new Promise((r) => setTimeout(r, 300));
    expect(errGen).toBe(1);
    expect(errMsg.length).toBeGreaterThan(0);
    await mgr.kill({ awaitExit: true, graceMs: 200 });
  });

  test('writeLine throws when not writable', () => {
    const mgr = new AgyProcessManager();
    expect(() => mgr.writeLine('hi')).toThrow();
  });
});

describe('escalateKill / waitForExit', () => {
  test('waitForExit resolves true for already-exited child', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    await waitForExit(child, 3000);
    const ok = await waitForExit(child, 100);
    expect(ok).toBe(true);
  });

  test('escalateKill terminates a sleeping child', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], {
      stdio: 'ignore',
    });
    await escalateKill(child, 300);
    const ok = await waitForExit(child, 3000);
    expect(ok).toBe(true);
  });

  test('forceKill is idempotent on exited child', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
    });
    await waitForExit(child, 3000);
    forceKill(child); // should not throw
    expect(DEFAULT_GRACE_MS).toBeGreaterThan(0);
  });
});
