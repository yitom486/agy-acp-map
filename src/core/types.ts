import { SAFETY_TIERS } from '../lib/agy-args.ts';
import type { AgyProcessManager } from '../lib/agy-process.ts';
import type { MapperState } from '../lib/map-agy-to-acp.ts';
import type { SoftDenyInfo } from '../lib/soft-deny.ts';

export const AGENT_INFO = {
  name: 'agy-acp',
  title: 'agy ACP (stream-json)',
  version: '0.1.18',
};

export const BRIDGE_CAPABILITIES = {
  prompt: true,
  streaming: true,
  tools: true,
  resume: true,
  permissionRoundTrip: false,
  permissionMode: 'safety_tiers',
  safetyTiers: [...SAFETY_TIERS],
  nativeCancel: false,
  cancelMode: 'SIGINT_then_KILL',
  historyReplay: true,
  dynamicConfig: 'restart',
  richContentInput: 'degrade_to_files',
  richContentOutput: 'best_effort',
  clientFilesystem: false,
  clientTerminal: false,
};

export type ProtocolVersion = 1 | 2;

export interface CatalogChoice {
  value: string;
  name: string;
  description?: string;
}

export function catalogChoices(items: unknown, currentValue?: string): CatalogChoice[] {
  const choices: CatalogChoice[] = [];
  const seen = new Set<string>();

  if (Array.isArray(items)) {
    for (const item of items) {
      let value: string | undefined;
      let name: string | undefined;
      let description: string | undefined;

      if (typeof item === 'string') {
        value = item.trim();
        name = value;
      } else if (item && typeof item === 'object') {
        const candidate = item as Record<string, unknown>;
        value =
          typeof candidate.id === 'string'
            ? candidate.id.trim()
            : typeof candidate.value === 'string'
              ? candidate.value.trim()
              : undefined;
        name = typeof candidate.name === 'string' ? candidate.name.trim() : value;
        description =
          typeof candidate.description === 'string' && candidate.description.trim()
            ? candidate.description.trim()
            : undefined;
      }

      if (!value || seen.has(value)) continue;
      seen.add(value);
      choices.push({ value, name: name || value, ...(description ? { description } : {}) });
    }
  }

  // Resumed session may contain a model/agent that CLI catalog no longer reports
  if (currentValue && !seen.has(currentValue)) {
    choices.unshift({
      value: currentValue,
      name: currentValue,
      description: 'Current session value',
    });
  }

  return choices;
}

export interface SdkSession {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  createdAt: string;
  updatedAt: string;
  title?: string;
  proc: AgyProcessManager;
  mapper: MapperState;
  busy: boolean;
  cancelled: boolean;
  protocolVersion: ProtocolVersion;
  stderrBuf: string;
  softDenies: SoftDenyInfo[];
  softDenyEmitted: boolean;
  stagedFiles: string[];
  conversationId?: string;
  model?: string;
  effort?: string;
  mode?: string;
  agent?: string;
  sandbox?: boolean;
  jsonSchema?: string;
  safety?: 'safe' | 'autonomous' | 'autonomous-unsandboxed';
  skipPermissions?: boolean;
  disableSlashCommands?: boolean;
  printTimeout?: string;
  deleted?: boolean;
  /** MCP servers this session registered (tracked for delete-time cleanup). */
  mcpServers?: Array<{ name: string }>;
}

/**
 * Sequential FIFO execution queue to eliminate notification ordering races.
 */
export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue(fn: () => Promise<void> | void): Promise<void> {
    const next = this.tail.then(() => fn()).catch((err) => {
      console.error('[AgyAcpService Queue Error]', err);
    });
    this.tail = next;
    return next;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}
