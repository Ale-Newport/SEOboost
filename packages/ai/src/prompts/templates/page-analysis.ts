import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, bullets, clip, jsonBlock, lines, section } from '../shared';

export interface PageAnalysisVars {
  url: string;
  title?: string | null;
  metaDescription?: string | null;
  headings?: readonly string[] | null;
  content: string;
  wordCount?: number | null;
  /** Technical issues the deterministic rules already found — do not re-derive these. */
  knownIssues?: readonly string[] | null;
  /** Search Console metrics for this URL. */
  metrics?: Readonly<Record<string, number | null>> | null;
  targetKeyword?: string | null;
  internalLinksIn?: number | null;
  internalLinksOut?: number | null;
}

export const pageAnalysisPrompt = registerPrompt<PageAnalysisVars>({
  id: 'page-analysis',
  version: 1,
  description: 'Judge what a single page is for, how well it serves it, and what to change.',
  defaultRole: 'fast',
  system: lines(
    'You analyse one page: what it is for, how well it serves that purpose, and what to change.',
    '',
    'Deterministic rules have already found the technical issues and they are listed for you.',
    'Do not repeat them. Your value is the judgement a rule cannot make: is this page about',
    'anything, does it serve a real searcher, does it deserve to exist on this site at all.',
    '',
    'Report:',
    '- primaryPurpose: what this page exists to do, in one sentence.',
    '- servedIntent: the intent it actually serves, which may differ from the intent it targets.',
    '  Name the mismatch when there is one — it is the most common cause of a page that has',
    '  impressions but no clicks.',
    '- inferredTargetKeyword: the term this page is trying to rank for, judged from the copy,',
    '  and whether that matches the assigned target keyword if one was supplied.',
    '- contentQuality 0-100 with evidence.',
    '- topicalCompleteness: subtopics a reader would expect that the page omits.',
    '- uniqueValue: what this page offers that a generic article on the topic does not. Say',
    '  "none identified" when that is the truth.',
    '- pageVerdict: KEEP, IMPROVE, CONSOLIDATE, REWRITE or REMOVE, with the reason. Recommend',
    '  REMOVE only when the page has no traffic, no links, no purpose and no path to one — and',
    '  note that removal always needs a human decision and a redirect plan.',
    '- topChanges: at most five concrete changes, most valuable first, each specific enough to',
    '  act on without further analysis.',
    '',
    'Interpret the metrics rather than restating them. High impressions with low CTR points at',
    'title and description; good position with no conversions points at intent mismatch; no',
    'impressions at all points at indexing or topic viability, so say which the data supports.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Page',
        lines(
          `URL: ${vars.url}`,
          vars.title ? `Title: ${vars.title}` : 'Title: missing',
          vars.metaDescription ? `Meta description: ${vars.metaDescription}` : 'Meta description: missing',
          vars.targetKeyword ? `Assigned target keyword: "${vars.targetKeyword}"` : '',
          vars.wordCount ? `Word count: ${vars.wordCount}` : '',
          vars.internalLinksIn !== null && vars.internalLinksIn !== undefined
            ? `Internal links in: ${vars.internalLinksIn}`
            : '',
          vars.internalLinksOut !== null && vars.internalLinksOut !== undefined
            ? `Internal links out: ${vars.internalLinksOut}`
            : '',
        ),
      ),
      section('Search Console metrics', vars.metrics ? jsonBlock(vars.metrics) : ''),
      section('Headings', bullets(vars.headings?.slice(0, 60))),
      section('Technical issues already detected — do not repeat these', bullets(vars.knownIssues)),
      section('Content', clip(vars.content, 30000)),
      'Analyse this page.',
    ),
});
