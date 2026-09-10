import 'server-only';
import type { AgentName } from '@seo/agents/types';

/**
 * The agent catalogue the API advertises.
 *
 * `agents.run` addresses an agent by a stable kebab-case registry key (`'technical-seo'`),
 * while the agent framework types it as `AgentName`. This table is the mapping between the
 * two plus the operator-facing copy, and it is keyed off `AgentName` so the day an agent is
 * added to the framework without an entry here is a compile error rather than a silent gap.
 *
 * `GET /api/agents` also unions in any agent key that actually appears in `AgentRun` history,
 * so a worker running an agent this build does not know about still shows up in the UI.
 */

export interface AgentCatalogueEntry {
  /** Registry key used in the `agents.run` payload. */
  key: string;
  name: AgentName;
  label: string;
  description: string;
  /** Does the agent need a configured AI provider to produce anything? */
  requiresAi: boolean;
  category: 'technical' | 'content' | 'keywords' | 'geo' | 'strategy';
}

const CATALOGUE: { readonly [K in AgentName]: Omit<AgentCatalogueEntry, 'name'> } = {
  TechnicalSEOAgent: {
    key: 'technical-seo',
    label: 'Technical SEO',
    description:
      'Audits crawlability, indexability, metadata and site architecture from the latest crawl, then proposes concrete fixes.',
    requiresAi: false,
    category: 'technical',
  },
  KeywordAgent: {
    key: 'keyword',
    label: 'Keyword research',
    description:
      'Finds striking-distance queries, content gaps and cannibalisation from Search Console and SERP data, and scores the opportunity.',
    requiresAi: false,
    category: 'keywords',
  },
  ContentStrategyAgent: {
    key: 'content-strategy',
    label: 'Content strategy',
    description:
      'Turns keyword clusters and gaps into a prioritised content plan, deciding whether to create, improve, consolidate or leave alone.',
    requiresAi: true,
    category: 'content',
  },
  ContentWriterAgent: {
    key: 'content-writer',
    label: 'Content writer',
    description:
      'Runs the drafting stages of the content pipeline against an approved brief, citing only verified brand facts.',
    requiresAi: true,
    category: 'content',
  },
  ContentRefreshAgent: {
    key: 'content-refresh',
    label: 'Content refresh',
    description:
      'Detects decaying pages and proposes targeted updates to the sections that lost their ranking, rather than rewrites.',
    requiresAi: true,
    category: 'content',
  },
  InternalLinkAgent: {
    key: 'internal-link',
    label: 'Internal linking',
    description:
      'Builds the internal link graph, finds orphans and under-linked pages, and suggests contextual links with natural anchors.',
    requiresAi: false,
    category: 'technical',
  },
  SchemaAgent: {
    key: 'schema',
    label: 'Structured data',
    description:
      'Generates and validates JSON-LD for pages, using only facts that are visibly present on the page.',
    requiresAi: false,
    category: 'technical',
  },
  CompetitorAgent: {
    key: 'competitor',
    label: 'Competitors',
    description:
      'Compares visibility, keyword overlap and content depth against tracked competitors and reports where the gap is closable.',
    requiresAi: false,
    category: 'keywords',
  },
  GEOAgent: {
    key: 'geo',
    label: 'GEO readiness',
    description:
      'Scores pages for generative-engine readiness — entity clarity, fact density, structure, citation-worthiness — and proposes fixes.',
    requiresAi: true,
    category: 'geo',
  },
  AIVisibilityAgent: {
    key: 'ai-visibility',
    label: 'AI visibility',
    description:
      'Runs the tracked prompt set against configured AI providers and records brand mentions, citations and competitor share of voice.',
    requiresAi: true,
    category: 'geo',
  },
  IndexationAgent: {
    key: 'indexation',
    label: 'Indexation',
    description:
      'Watches which pages are indexed versus submitted, and proposes sitemap and indexing-submission work for the gaps.',
    requiresAi: false,
    category: 'technical',
  },
  AnalyticsAgent: {
    key: 'analytics',
    label: 'Analytics',
    description:
      'Reads Search Console and GA4 history to explain movements, and flags the pages and queries behind them.',
    requiresAi: false,
    category: 'strategy',
  },
  SEOManagerAgent: {
    key: 'seo-manager',
    label: 'AI SEO Manager',
    description:
      'The orchestrator: reviews every signal for a site and produces the today / this week / this month plan.',
    requiresAi: true,
    category: 'strategy',
  },
};

export const AGENT_CATALOGUE: AgentCatalogueEntry[] = (Object.keys(CATALOGUE) as AgentName[]).map(
  (name) => ({ name, ...CATALOGUE[name] }),
);

export function findAgent(key: string): AgentCatalogueEntry | null {
  const needle = key.trim().toLowerCase();
  return (
    AGENT_CATALOGUE.find((agent) => agent.key === needle) ??
    AGENT_CATALOGUE.find((agent) => agent.name.toLowerCase() === needle) ??
    null
  );
}

export const AGENT_KEYS: string[] = AGENT_CATALOGUE.map((agent) => agent.key);
