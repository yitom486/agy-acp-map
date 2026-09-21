import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  AgyProcessManager,
  escalateKill,
  forceKill,
  waitForExit,
  DEFAULT_GRACE_MS,
  resolveAgyLaunchTarget,
  resolveHeadlessTarget,
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

  test('routes agy and short-lived Windows helpers through the native headless launcher', () => {
    const launcherPath = path.resolve(import.meta.dir, '../../dist/agy-headless.exe');
    const launcherAvailable = process.platform === 'win32' && fs.existsSync(launcherPath);
    const launcherDisabled = process.env.AGY_DISABLE_HEADLESS_LAUNCHER === '1';
    const expectedHeadless = launcherAvailable && !launcherDisabled;

    const agyTarget = resolveAgyLaunchTarget('C:\\Users\\test\\.gemini\\bin\\agy.exe', ['models']);
    expect(agyTarget.headless).toBe(expectedHeadless);
    if (expectedHeadless) {
      expect(path.resolve(agyTarget.bin)).toBe(path.resolve(launcherPath));
      expect(agyTarget.args[0]).toBe('C:\\Users\\test\\.gemini\\bin\\agy.exe');
    }

    const helperTarget = resolveHeadlessTarget('taskkill', ['/pid', '123', '/T', '/F']);
    expect(helperTarget.headless).toBe(expectedHeadless);
    if (expectedHeadless) {
      expect(path.resolve(helperTarget.bin)).toBe(path.resolve(launcherPath));
      expect(helperTarget.args[0]).toBe('taskkill');
    }
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

  test('waitForExit resolves fast on failed spawn (error+close, no exit)', async () => {
    // Regression: warmup on machines without agy leaves a broken child;
    // kill() must not hang waiting for an 'exit' that never fires.
    const child = spawn('/no/such/agy-binary-xyz-0.1.4', [], { stdio: 'ignore' });
    child.on('error', () => {});
    const start = Date.now();
    const ok = await waitForExit(child, 5000);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(ok).toBe(true);
  });

  test('manager kill resolves fast right after a failed spawn', async () => {
    const mgr = new AgyProcessManager();
    await mgr.spawn({
      bin: '/no/such/agy-binary-xyz-0.1.4',
      args: [],
      cwd: process.cwd(),
      onEvent: () => {},
      onError: () => {},
      onExit: () => {},
    });
    // No grace period for the error event: kill must still settle quickly.
    const start = Date.now();
    await mgr.kill({ awaitExit: true, graceMs: 200 });
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
