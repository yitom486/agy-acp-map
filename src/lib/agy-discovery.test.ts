import { describe, expect, test } from 'bun:test';
import { parseAgyModelsStdout, parseAgyAgentsStdout } from './agy-discovery.ts';

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
