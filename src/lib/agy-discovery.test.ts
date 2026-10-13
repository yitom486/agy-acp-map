import { describe, expect, test } from 'bun:test';
import {
  parseAgyModelsStdout,
  parseAgyAgentsStdout,
  discoverAgyCatalog,
  clearDiscoveryCache,
  DEFAULT_AGY_MODELS,
} from './agy-discovery.ts';

describe('parseAgyModelsStdout', () => {
  test('parses tab-separated catalog; skips Fetching line', () => {
    const fixture = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`;
    expect(parseAgyModelsStdout(fixture)).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.1-pro-low',
      'claude-sonnet-4-6',
    ]);
  });

  test('empty / junk → []', () => {
    expect(parseAgyModelsStdout('')).toEqual([]);
    expect(parseAgyModelsStdout('Fetching available models...\n')).toEqual([]);
  });
});

describe('parseAgyAgentsStdout', () => {
  test('parses id-per-line and tab names', () => {
    const fixture = `Available agents
default\tDefault agent
coder\tCoding agent
research
`;
    expect(parseAgyAgentsStdout(fixture)).toEqual(['default', 'coder', 'research']);
  });

  test('empty stdout → []', () => {
    expect(parseAgyAgentsStdout('')).toEqual([]);
    expect(parseAgyAgentsStdout('Usage: agy agent [flags]\n')).toEqual([]);
  });
});

describe('discoverAgyCatalog', () => {
  test('DEFAULT_AGY_MODELS contains only active verified models', () => {
    expect(DEFAULT_AGY_MODELS).toContain('gemini-3.8-flash-high');
    expect(DEFAULT_AGY_MODELS).toContain('claude-sonnet-4-6');
    expect(DEFAULT_AGY_MODELS).not.toContain('gemini-3.7-flash-high');
    expect(DEFAULT_AGY_MODELS).not.toContain('gemini-3.6-flash-high');
    expect(DEFAULT_AGY_MODELS).not.toContain('gemini-3.1-pro-high');
  });

  test('returns static pruned DEFAULT_AGY_MODELS when dynamic is false', async () => {
    clearDiscoveryCache();
    const result = await discoverAgyCatalog({ dynamic: false, force: true });
    expect(result.availableModels).toEqual(DEFAULT_AGY_MODELS);
    expect(result.availableAgents).toEqual([]);
  });

  test('returns static models when AGY_DYNAMIC_DISCOVERY=false env is set', async () => {
    clearDiscoveryCache();
    const orig = process.env.AGY_DYNAMIC_DISCOVERY;
    try {
      process.env.AGY_DYNAMIC_DISCOVERY = 'false';
      const result = await discoverAgyCatalog({ force: true });
      expect(result.availableModels).toEqual(DEFAULT_AGY_MODELS);
    } finally {
      process.env.AGY_DYNAMIC_DISCOVERY = orig;
    }
  });
});

