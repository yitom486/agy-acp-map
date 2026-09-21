import type * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import type { DiscoveryResult } from '../lib/agy-discovery.ts';
import { catalogChoices, type SdkSession } from '../core/types.ts';

/**
 * Builds experimental ACP v2 session configuration options.
 * In ACP v2, the selector ID field is named `configId`.
 */
export function buildV2ConfigOptions(
  discovery: DiscoveryResult,
  session?: Pick<SdkSession, 'model' | 'agent'>,
): v2.SessionConfigOption[] {
  const models = catalogChoices(discovery.availableModels, session?.model);
  const agents = catalogChoices(discovery.availableAgents, session?.agent);
  const options: v2.SessionConfigOption[] = [];

  if (models.length) {
    options.push({
      type: 'select',
      configId: 'model',
      name: 'Model',
      description: 'Google Antigravity model ID',
      category: 'model',
      currentValue: session?.model || models[0].value,
      options: models,
    } as v2.SessionConfigOption);
  }

  if (agents.length) {
    options.push({
      type: 'select',
      configId: 'agent',
      name: 'Agent preset',
      description: 'Specialized agent preset',
      category: '_agent',
      currentValue: session?.agent || agents[0].value,
      options: agents,
    } as v2.SessionConfigOption);
  }

  return options;
}
