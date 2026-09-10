import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, INTENT_DEFINITIONS, OUTPUT_CONTRACT, lines, section } from '../shared';

export interface KeywordIntentKeyword {
  keyword: string;
  /** Impressions or search volume, when a data source supplied one. */
  volume?: number | null;
  currentPosition?: number | null;
  /** Titles currently ranking for the term — the strongest available intent signal. */
  serpTitles?: readonly string[] | null;
}

export interface KeywordIntentVars {
  siteName: string;
  domain: string;
  businessCategory?: string | null;
  targetCountry?: string | null;
  keywords: readonly KeywordIntentKeyword[];
}

export const keywordIntentPrompt = registerPrompt<KeywordIntentVars>({
  id: 'keyword-intent',
  version: 1,
  description: 'Classify search intent, funnel stage and required page type for a set of keywords.',
  defaultRole: 'fast',
  system: lines(
    'You are a senior search strategist who classifies keyword intent for a living.',
    '',
    'You judge intent from the language of the query and, when supplied, from what actually',
    'ranks for it — the SERP is the search engine telling you what it believes the intent is.',
    'A query whose results are all comparison articles is commercial even if it reads',
    'informational; trust the SERP over your instinct when they disagree.',
    '',
    INTENT_DEFINITIONS,
    '',
    'For each keyword also decide:',
    '- funnelStage: AWARENESS (naming a problem), CONSIDERATION (evaluating approaches),',
    '  DECISION (choosing a vendor), RETENTION (already a customer).',
    '- pageType: the format that satisfies the intent — GUIDE, COMPARISON, LISTICLE,',
    '  PRODUCT, PRICING, TUTORIAL, GLOSSARY, CASE_STUDY, LANDING, NEWS, TOOL, FAQ.',
    '- commercialValue 0-1: how close this searcher is to spending money with THIS business,',
    '  not with the category in general. A high-volume term the business cannot monetise',
    '  scores low, and saying so is more useful than flattering the keyword.',
    '- difficultySignal: what the ranking titles suggest about who you are up against',
    '  (for example "dominated by marketplaces", "thin affiliate content, beatable").',
    '  Omit it when no ranking titles were supplied — do not guess at competition.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Site',
        lines(
          `Name: ${vars.siteName}`,
          `Domain: ${vars.domain}`,
          vars.businessCategory ? `Category: ${vars.businessCategory}` : '',
          vars.targetCountry ? `Primary market: ${vars.targetCountry}` : '',
        ),
      ),
      section(
        'Keywords to classify',
        vars.keywords
          .map((entry) => {
            const facts = [
              entry.volume !== null && entry.volume !== undefined ? `volume ${entry.volume}` : '',
              entry.currentPosition !== null && entry.currentPosition !== undefined
                ? `current position ${entry.currentPosition}`
                : '',
            ]
              .filter(Boolean)
              .join(', ');
            const serp = entry.serpTitles?.length
              ? `\n  ranking titles: ${entry.serpTitles.slice(0, 8).join(' | ')}`
              : '';
            return `- "${entry.keyword}"${facts ? ` (${facts})` : ''}${serp}`;
          })
          .join('\n'),
      ),
      'Classify every keyword above. Return one entry per keyword, in the same order.',
    ),
});
