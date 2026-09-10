import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, bullets, jsonBlock, lines, section } from '../shared';

export interface SiteSummaryVars {
  siteName: string;
  domain: string;
  /** Sample of page titles and URLs — the primary evidence for what the site is. */
  samplePages: readonly { url: string; title?: string | null }[];
  homepageText?: string | null;
  topQueries?: readonly string[] | null;
  scores?: Readonly<Record<string, number | null>> | null;
  pageCount?: number | null;
  /** Period for which the metrics were computed, so the summary can date its claims. */
  period?: string | null;
}

export const siteSummaryPrompt = registerPrompt<SiteSummaryVars>({
  id: 'site-summary',
  version: 1,
  description: 'Infer what a site is, who it serves and how it is performing, from crawl data.',
  defaultRole: 'fast',
  system: lines(
    'You read a site\'s crawl and query data and describe what the site actually is.',
    '',
    'This summary seeds the knowledge base and is shown to the operator for confirmation, so',
    'accuracy matters more than fluency. Where the evidence is thin, say the evidence is thin —',
    'a confidently wrong description of someone\'s business is worse than an incomplete one, and',
    'it will be silently inherited by every content prompt downstream.',
    '',
    'Produce:',
    '- businessDescription: what this organisation does, in two or three sentences, in plain',
    '  language, derived from the pages themselves rather than from the domain name.',
    '- category: the market category, as an industry practitioner would name it.',
    '- audience: who the pages are written for, with the evidence that says so.',
    '- productsOrServices: what appears to be sold, from product and pricing pages.',
    '- contentThemes: the topic areas the content covers, with rough weighting.',
    '- siteType: ECOMMERCE, SAAS, MEDIA, LOCAL_BUSINESS, MARKETPLACE, PORTFOLIO, DOCS,',
    '  COMMUNITY, NONPROFIT or OTHER.',
    '- performanceSummary: two or three sentences on how the site is doing, using only the',
    '  supplied scores and metrics, naming the period they cover.',
    '- notableStrengths and notableWeaknesses: grounded in the data, not generic advice.',
    '- confidence 0-1 and evidenceGaps: what you would need to see to be sure.',
    '',
    'Do not infer revenue, company size, funding, headcount or ownership. Do not name customers',
    'or partners unless a supplied page names them.',
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
          `${vars.siteName} (${vars.domain})`,
          vars.pageCount ? `Pages crawled: ${vars.pageCount}` : '',
          vars.period ? `Metrics period: ${vars.period}` : '',
        ),
      ),
      section('Scores', vars.scores ? jsonBlock(vars.scores) : ''),
      section(
        'Sample pages',
        vars.samplePages
          .slice(0, 120)
          .map((page) => `- ${page.url}${page.title ? ` — ${page.title}` : ''}`)
          .join('\n'),
      ),
      section('Top search queries bringing traffic', bullets(vars.topQueries?.slice(0, 50))),
      section('Homepage text', vars.homepageText ? vars.homepageText.slice(0, 6000) : ''),
      'Summarise this site.',
    ),
});
