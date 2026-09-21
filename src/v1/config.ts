import type * as v1 from '@agentclientprotocol/sdk';
import type { DiscoveryResult } from '../lib/agy-discovery.ts';
import { catalogChoices, type SdkSession } from '../core/types.ts';

/**
 * Builds standard ACP v1 session configuration options.
 * In ACP v1, the selector ID field is named `id`.
 */
export function buildV1ConfigOptions(
  discovery: DiscoveryResult,
  session?: Pick<SdkSession, 'model' | 'agent'>,
): v1.SessionConfigOption[] {
  const models = catalogChoices(discovery.availableModels, session?.model);
  const agents = catalogChoices(discovery.availableAgents, session?.agent);
  const options: v1.SessionConfigOption[] = [];

  if (models.length) {
    options.push({
      type: 'select',
      id: 'model',
      name: 'Model',
      description: 'Google Antigravity model ID',
      category: 'model',
      currentValue: session?.model || models[0].value,
      options: models,
    } as v1.SessionConfigOption);
  }

  if (agents.length) {
    options.push({
      type: 'select',
      id: 'agent',
      name: 'Agent preset',
      description: 'Specialized agent preset',
      category: '_agent',
      currentValue: session?.agent || agents[0].value,
      options: agents,
    } as v1.SessionConfigOption);
  }

  return options;
}
