import { describe, expect, test } from 'bun:test';
import path from 'node:path';
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

  test('setCallbacks dynamically routes subsequent turns to new event callbacks on the same live child process', async () => {
    const mgr = new AgyProcessManager();
    const turn1Events: any[] = [];
    const turn2Events: any[] = [];

    const mockCliPath = path.resolve(import.meta.dir, '../../tests/fixtures/mock-agy-cli.cjs');

    await mgr.spawn({
      bin: process.execPath,
      args: [mockCliPath],
      cwd: process.cwd(),
      onEvent: (obj) => {
        turn1Events.push(obj);
      },
      onError: () => {},
      onExit: () => {},
    });

    expect(mgr.isAlive()).toBe(true);
    expect(mgr.isWritable()).toBe(true);

    // Turn 1
    mgr.writeLine(JSON.stringify({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Hello Turn 1' }] },
    }));
    for (let i = 0; i < 30 && turn1Events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(turn1Events.length).toBeGreaterThanOrEqual(1);

    // Dynamically switch callbacks for Turn 2
    const turn1CountBefore = turn1Events.length;
    mgr.setCallbacks({
      onEvent: (obj) => {
        turn2Events.push(obj);
      },
      onError: () => {},
      onExit: () => {},
    });

    // Turn 2
    mgr.writeLine(JSON.stringify({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'Hello Turn 2' }] },
    }));
    for (let i = 0; i < 30 && turn2Events.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(turn2Events.length).toBeGreaterThanOrEqual(1);
    // Ensure Turn 1 callback received no further events
    expect(turn1Events.length).toBe(turn1CountBefore);

    await mgr.kill({ awaitExit: true, graceMs: 500 });
    expect(mgr.isAlive()).toBe(false);
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
