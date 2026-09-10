import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, bullets, clip, lines, section } from '../shared';

export interface ContentDecisionExistingPage {
  url: string;
  title?: string | null;
  wordCount?: number | null;
  currentPosition?: number | null;
  impressions?: number | null;
  clicks?: number | null;
  lastModified?: string | null;
  /** How close this page already is to the target topic, 0-1, from vector similarity. */
  similarity?: number | null;
  excerpt?: string | null;
}

export interface ContentDecisionVars {
  siteName: string;
  targetKeyword: string;
  intent?: string | null;
  clusterName?: string | null;
  /** Pages the similarity search says are closest to the target topic. */
  candidatePages: readonly ContentDecisionExistingPage[];
  /** Titles currently ranking, when a SERP source is connected. */
  serpTitles?: readonly string[] | null;
}

/** Metrics line for one candidate page; empty when nothing was measured. */
function metricsOf(page: ContentDecisionExistingPage): string {
  const parts = [
    page.similarity !== null && page.similarity !== undefined
      ? `similarity ${page.similarity.toFixed(2)}`
      : '',
    page.wordCount ? `${page.wordCount} words` : '',
    page.currentPosition ? `position ${page.currentPosition}` : '',
    page.impressions ? `${page.impressions} impressions` : '',
    page.clicks !== null && page.clicks !== undefined ? `${page.clicks} clicks` : '',
    page.lastModified ? `updated ${page.lastModified}` : '',
  ].filter(Boolean);
  return parts.length ? `  metrics: ${parts.join(', ')}` : '';
}

export const contentDecisionPrompt = registerPrompt<ContentDecisionVars>({
  id: 'content-decision',
  version: 1,
  description: 'Decide whether to create, update, consolidate or skip content for a keyword.',
  defaultRole: 'reasoning',
  system: lines(
    'You decide what to DO about a keyword, before anyone writes anything.',
    '',
    'Publishing a new page when an existing one already targets the topic is the single most',
    'expensive mistake in content SEO: it splits link equity, competes with itself, and costs',
    'more than the update would have. Your default is therefore to improve what exists.',
    '',
    'Choose exactly one decision:',
    '- CREATE_NEW: no existing page serves this intent, and the topic deserves its own page.',
    '- UPDATE_EXISTING: a page already targets this intent but underperforms or is incomplete.',
    '  Name the page and say precisely what is missing.',
    '- CONSOLIDATE: two or more pages compete for the same intent. Name the winner, the pages',
    '  to merge into it, and what must be preserved from each. Flag that redirects are needed.',
    '- REFRESH: the page is structurally right but stale — dates, prices, screenshots, links.',
    '- SKIP: the term is not worth pursuing (irrelevant to the business, unwinnable, or',
    '  already served well). Saying no is a valid and valuable answer.',
    '',
    'Judgement rules:',
    '- High similarity plus a poor position usually means UPDATE, not CREATE.',
    '- Two pages with similar similarity and split impressions on the same term is',
    '  cannibalisation: CONSOLIDATE.',
    '- A page ranking in positions 8-20 is a striking-distance opportunity — updating it beats',
    '  starting from zero almost every time.',
    '- Base every claim on the supplied metrics. Do not assert traffic, rankings or competitor',
    '  behaviour that is not in the input, and do not assume a page is thin because its word',
    '  count is unknown.',
    '- Give a confidence 0-1 and state what additional data would raise it.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Target',
        lines(
          `Site: ${vars.siteName}`,
          `Keyword: "${vars.targetKeyword}"`,
          vars.intent ? `Intent: ${vars.intent}` : '',
          vars.clusterName ? `Cluster: ${vars.clusterName}` : '',
        ),
      ),
      section(
        'Existing pages closest to this topic',
        vars.candidatePages.length
          ? vars.candidatePages
              .map((page) =>
                lines(
                  `- ${page.url}`,
                  page.title ? `  title: ${page.title}` : '',
                  metricsOf(page),
                  page.excerpt ? `  excerpt: ${clip(page.excerpt, 400)}` : '',
                ),
              )
              .join('\n')
          : 'None — the similarity search returned no comparable page.',
      ),
      section('Titles currently ranking for this keyword', bullets(vars.serpTitles?.slice(0, 10))),
      'Decide what to do about this keyword and justify it from the data above.',
    ),
});
