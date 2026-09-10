import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { findAgent, getAgent, isAgentRegistered, registerAgent, resetAgentRegistry } from '../registry';
import type { AgentDefinition, AgentName } from '../../types';

function stub(name: AgentName): AgentDefinition {
  return {
    name,
    label: name,
    description: 'test stub',
    allowedActionTypes: [],
    tools: [],
    requiresAi: false,
    inputSchema: z.object({}),
    run: async () => ({
      summary: '', confidence: 1, actionsCreated: [], approvalsCreated: [], findings: [], data: {},
    }),
  };
}

/**
 * The API addresses agents by a kebab key in URLs and `agents.run` payloads, while agents
 * register under their canonical `AgentName`. A registry that only matched the canonical form
 * made every enqueued agent run fail in the worker with "No agent named …".
 */
describe('agent registry aliases', () => {
  beforeEach(() => {
    resetAgentRegistry();
    registerAgent(stub('AnalyticsAgent'));
    registerAgent(stub('TechnicalSEOAgent'));
    registerAgent(stub('AIVisibilityAgent'));
    registerAgent(stub('SEOManagerAgent'));
    registerAgent(stub('InternalLinkAgent'));
    registerAgent(stub('GEOAgent'));
  });

  it.each([
    ['AnalyticsAgent', 'analytics'],
    ['TechnicalSEOAgent', 'technical-seo'],
    ['AIVisibilityAgent', 'ai-visibility'],
    ['SEOManagerAgent', 'seo-manager'],
    ['InternalLinkAgent', 'internal-link'],
    ['GEOAgent', 'geo'],
  ])('resolves %s from its API key "%s"', (canonical, key) => {
    expect(findAgent(key)?.name).toBe(canonical);
    expect(getAgent(key).name).toBe(canonical);
    expect(isAgentRegistered(key)).toBe(true);
  });

  it('still resolves the canonical name directly', () => {
    expect(findAgent('AnalyticsAgent')?.name).toBe('AnalyticsAgent');
  });

  it('tolerates the kebab form with the Agent suffix, as older rows may carry it', () => {
    expect(findAgent('analytics-agent')?.name).toBe('AnalyticsAgent');
  });

  it('returns undefined for a genuinely unknown agent rather than a near match', () => {
    expect(findAgent('does-not-exist')).toBeUndefined();
    expect(() => getAgent('does-not-exist')).toThrow(/does-not-exist/);
  });
});
