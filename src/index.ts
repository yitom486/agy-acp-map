/**
 * agy-acp-map: Official ACP v1/v2 Bridge for Google Antigravity CLI (agy).
 * Primary entry point for library consumption in Node, Bun, and Electron.
 */

// Official SDK Service & App Factory
export {
  AgyAcpService,
  createAcpV1App,
  createAcpV2App,
  createDualAcpApp,
  AGENT_INFO,
  BRIDGE_CAPABILITIES,
  type SdkSession,
} from './agent-sdk.ts';

// Core Engine & Domain Modules
export * from './lib/map-agy-to-acp.ts';
export * from './lib/agy-process.ts';
export * from './lib/agy-args.ts';
export * from './lib/soft-deny.ts';
export * from './lib/prompt-normalize.ts';
export * from './lib/rich-content.ts';
export * from './lib/path-allowlist.ts';
export * from './lib/agy-discovery.ts';
export * from './lib/session-store.ts';
