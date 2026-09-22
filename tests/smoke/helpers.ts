import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_SERVER_PATH = path.resolve(__dirname, '../../src/sdk-server.ts');
export const FIXTURES_DIR = path.resolve(__dirname, '../fixtures');

export function ensurePath(): void {
  const extra = '/home/box/.local/bin';
  const p = process.env.PATH || '';
  if (!p.split(path.delimiter).includes(extra)) {
    process.env.PATH = `${extra}${path.delimiter}${p}`;
  }
}

export interface SmokeHarnessOptions {
  tag?: string;
  serverPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  onServerLog?: (line: string) => void;
  onUpdate?: (update: any, rawMsg: any) => void;
}

export interface SmokeHarness {
  child: ChildProcess;
  send: (method: string, params?: any) => Promise<any>;
  notify: (method: string, params?: any) => void;
  waitIdle: (timeoutMs?: number, sessionId?: string | null) => Promise<any>;
  log: (subTag: string, obj: any) => void;
  kill: (signal?: NodeJS.Signals) => void;
  agentTexts: string[];
  events: any[];
  serverLogs: string[];
}

export function createSmokeHarness(opts: SmokeHarnessOptions = {}): SmokeHarness {
  ensurePath();
  const tag = opts.tag || 'smoke';
  const serverPath = opts.serverPath || DEFAULT_SERVER_PATH;
  const cwd = opts.cwd || path.resolve(__dirname, '../..');

  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...opts.env },
    cwd,
  });

  let nextId = 1;
  const pending = new Map<number, { method: string; resolve: (val: any) => void; reject: (err: any) => void }>();
  const events: any[] = [];
  const serverLogs: string[] = [];
  const agentTexts: string[] = [];

  let lastIdle: any = null;
  let onIdleCallback: ((u: any) => void) | null = null;

  function log(subTag: string, obj: any) {
    const line = typeof obj === 'string' ? obj : JSON.stringify(obj);
    console.log(`[${tag}:${subTag}] ${line}`);
    events.push({ subTag, at: Date.now(), obj });
  }

  function send(method: string, params?: any): Promise<any> {
    const id = nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    try {
      if (!child.stdin || child.stdin.destroyed || child.exitCode !== null) {
        return Promise.reject(
          new Error(`[${tag}] send ${method}: server stdio gone (exit=${child.exitCode}, signal=${child.signalCode})`),
        );
      }
      child.stdin.write(JSON.stringify(msg) + '\n');
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    log('→', msg);
    return new Promise((resolve, reject) => {
      pending.set(id, { method, sessionId: params?.sessionId, resolve, reject });
    });
  }

  function failPending(reason: string): void {
    if (pending.size === 0) return;
    log('server-gone', `${reason}; failing ${pending.size} pending request(s)`);
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new Error(`[${tag}] ${p.method} #${id} failed: ${reason}`));
    }
    if (onIdleCallback) {
      onIdleCallback = null;
    }
  }

  child.on('error', (err: Error) => {
    failPending(`server spawn error: ${err.message}`);
  });

  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    log('server-exit', `code=${code} signal=${signal}`);
    failPending(`server exited (code=${code}, signal=${signal}) before responding`);
  });

  function notify(method: string, params?: any): void {
    const msg = { jsonrpc: '2.0', method, params };
    child.stdin?.write(JSON.stringify(msg) + '\n');
    log('notify→', msg);
  }

  function waitIdle(timeoutMs = 90000, sessionId: string | null = null): Promise<any> {
    return new Promise((resolve, reject) => {
      if (lastIdle && lastIdle.pending && (!sessionId || !lastIdle.sessionId || lastIdle.sessionId === sessionId)) {
        lastIdle.pending = false;
        resolve(lastIdle);
        return;
      }
      const timer = setTimeout(() => {
        onIdleCallback = null;
        reject(new Error(`[${tag}] timeout waiting for idle state (${timeoutMs}ms)`));
      }, timeoutMs);

      onIdleCallback = (u) => {
        if (!sessionId || !u.sessionId || u.sessionId === sessionId) {
          clearTimeout(timer);
          onIdleCallback = null;
          resolve(u);
        }
      };
    });
  }

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const t = line.trim();
    if (!t) return;
    let msg: any;
    try {
      msg = JSON.parse(t);
    } catch {
      log('bad', t.slice(0, 200));
      return;
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      log('←', msg);
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(msg.error);
        } else {
          if (msg.result && typeof msg.result === 'object' && msg.result.stopReason) {
            const idlePayload = {
              sessionId: p.sessionId || null,
              stopReason: msg.result.stopReason,
              pending: true,
            };
            lastIdle = idlePayload;
            if (onIdleCallback) {
              lastIdle.pending = false;
              onIdleCallback(idlePayload);
            }
          }
          p.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method) {
      log('notify', msg);
      if (msg.method === 'session/update' && msg.params?.update) {
        const u = msg.params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
          agentTexts.push(u.content.text);
        }
        if (opts.onUpdate) {
          opts.onUpdate(u, msg);
        }
        if (u.sessionUpdate === 'state_update' && u.state === 'idle') {
          const idlePayload = {
            sessionId: msg.params.sessionId,
            stopReason: u.stopReason,
            pending: true,
          };
          lastIdle = idlePayload;
          if (onIdleCallback) {
            lastIdle.pending = false;
            onIdleCallback(idlePayload);
          }
        }
      }
    }
  });

  child.stderr?.on('data', (buf) => {
    for (const line of buf.toString().split('\n')) {
      if (line.trim()) {
        serverLogs.push(line);
        if (opts.onServerLog) {
          opts.onServerLog(line);
        } else {
          console.error(`[${tag}:server] ${line}`);
        }
      }
    }
  });

  function kill(signal: NodeJS.Signals = 'SIGTERM') {
    try {
      child.kill(signal);
    } catch {
      /* ignore */
    }
  }

  return {
    child,
    send,
    notify,
    waitIdle,
    log,
    kill,
    agentTexts,
    events,
    serverLogs,
  };
}
