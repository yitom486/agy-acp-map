#!/usr/bin/env bun
/**
 * Official ACP SDK Server Entry Point (Dual v1 / v2 protocol support).
 * Connects standard Stdio to the AgyAcpService via @agentclientprotocol/sdk.
 */
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { createDualAcpApp, AgyAcpService } from './agent-sdk.ts';

const service = new AgyAcpService();
const app = createDualAcpApp(service);

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
);

process.stderr.write('[agy-acp-sdk] Starting official @agentclientprotocol/sdk stdio server...\n');
await app.connect(stream);
