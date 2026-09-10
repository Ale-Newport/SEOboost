import { registerPrompt } from '../registry';
import {
  ANALYSIS_RULES,
  OUTPUT_CONTRACT,
  bullets,
  lines,
  renderKnowledgeBase,
  section,
} from '../shared';
import type { PromptBrandFact, PromptKnowledgeBase } from '../shared';

export interface KeywordExpansionVars {
  siteName: string;
  domain: string;
  seedKeywords: readonly string[];
  /** Terms the site already ranks for, so the model widens coverage instead of repeating it. */
  existingKeywords?: readonly string[] | null;
  /** Page titles or URLs that describe what the site actually sells. */
  siteTopics?: readonly string[] | null;
  targetCountry?: string | null;
  language?: string | null;
  maxSuggestions?: number | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const keywordExpansionPrompt = registerPrompt<KeywordExpansionVars>({
  id: 'keyword-expansion',
  version: 1,
  description: 'Expand seed keywords into related queries the site could realistically win.',
  defaultRole: 'reasoning',
  system: lines(
    'You are a keyword researcher who expands a seed set into the queries a real business can',
    'realistically win, not into the largest possible list.',
    '',
    'Expand along these axes, and label which one each suggestion came from:',
    '- MODIFIER: qualifiers real searchers add (best, cheap, free, near me, for <persona>,',
    '  <year>, alternative, template, example, checklist).',
    '- QUESTION: how/what/why/when/can/does phrasings, including the ones people ask an',
    '  assistant rather than a search box.',
    '- PROBLEM: the symptom or job-to-be-done wording someone uses before they know the',
    '  category name at all. These are the highest-value and most often missed.',
    '- COMPARISON: X vs Y, alternatives to X, X or Y.',
    '- LONG_TAIL: specific multi-word queries with clear intent and low competition.',
    '- ADJACENT: neighbouring topics the same audience searches while solving the same problem.',
    '- SEMANTIC: entities, subtopics and synonyms a topically complete page should cover.',
    '',
    'Hard constraints:',
    '- Only propose terms this site could plausibly serve. A term the business has no product,',
    '  content or expertise for is noise, however large its volume.',
    '- Do not restate a seed, an existing keyword, or another suggestion with the words',
    '  reordered. Near-duplicates are the main failure mode of keyword expansion.',
    '- Never output a search volume, difficulty score or CPC. You do not have that data and a',
    '  fabricated number would be imported into the database as if it were measured.',
    '- Estimate relevance 0-1 to the business and give a one-line rationale grounded in the',
    '  supplied site context.',
    '- Use the site language and market conventions in the wording (spelling, units, currency).',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      renderKnowledgeBase(vars.knowledgeBase, vars.brandFacts),
      '',
      section(
        'Site',
        lines(
          `Name: ${vars.siteName}`,
          `Domain: ${vars.domain}`,
          vars.targetCountry ? `Market: ${vars.targetCountry}` : '',
          vars.language ? `Language: ${vars.language}` : '',
        ),
      ),
      section('Seed keywords', bullets(vars.seedKeywords)),
      section('Topics the site already covers', bullets(vars.siteTopics?.slice(0, 60))),
      section(
        'Keywords already tracked — do not suggest these again',
        bullets(vars.existingKeywords?.slice(0, 200)),
      ),
      `Produce at most ${vars.maxSuggestions ?? 40} suggestions, ordered by relevance to the business.`,
    ),
});
