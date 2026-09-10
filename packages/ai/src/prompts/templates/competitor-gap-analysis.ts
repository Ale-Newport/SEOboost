import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, bullets, jsonBlock, lines, section } from '../shared';

export interface CompetitorGapKeyword {
  keyword: string;
  ourPosition?: number | null;
  competitorPositions?: Readonly<Record<string, number>> | null;
  volume?: number | null;
}

export interface CompetitorGapTopic {
  topic: string;
  ourPages?: number | null;
  competitorPages?: Readonly<Record<string, number>> | null;
}

export interface CompetitorGapAnalysisVars {
  siteName: string;
  domain: string;
  competitors: readonly string[];
  /** Keyword-level overlap, already computed from ranking data. */
  keywordGaps?: readonly CompetitorGapKeyword[] | null;
  /** Topic coverage counts per competitor. */
  topicGaps?: readonly CompetitorGapTopic[] | null;
  /** Formats or page types competitors publish that this site does not. */
  competitorContentTypes?: readonly string[] | null;
  businessCategory?: string | null;
}

export const competitorGapAnalysisPrompt = registerPrompt<CompetitorGapAnalysisVars>({
  id: 'competitor-gap-analysis',
  version: 1,
  description: 'Turn competitor overlap data into a prioritised set of winnable opportunities.',
  defaultRole: 'reasoning',
  system: lines(
    'You analyse where competitors are winning and decide which of those gaps this site should',
    'actually contest.',
    '',
    'The trap in gap analysis is treating every gap as an opportunity. A competitor ranking for',
    'something irrelevant to this business is not a gap; a competitor ranking for something this',
    'business could serve better is. Every recommendation must pass a "why us" test, and you',
    'should explicitly list gaps you are recommending against pursuing, with the reason.',
    '',
    'Classify each gap:',
    '- CONTENT_GAP: they have a page on the topic, we have none.',
    '- QUALITY_GAP: we have a page but it is outranked. Say what theirs plausibly does better',
    '  based on the supplied data, and do not speculate beyond it.',
    '- FORMAT_GAP: they serve the intent with a format we do not offer (tool, calculator,',
    '  template, comparison table, video).',
    '- DEPTH_GAP: we cover the topic shallowly across scattered pages; they have a cluster.',
    '- ENTITY_GAP: they are associated with an entity or category we are not.',
    '',
    'For each opportunity give: the gap type, the keywords or topics involved, which competitors',
    'hold it, an effort estimate, a winnability score 0-1 with justification, the business case',
    'in one sentence, and the concrete first action.',
    '',
    'Then summarise: the three moves with the best return, the single biggest structural',
    'weakness relative to these competitors, and any area where this site is already ahead and',
    'should defend rather than expand.',
    '',
    'Use only the supplied data. Do not assert a competitor\'s traffic, revenue, backlinks,',
    'publishing cadence or strategy that is not in the input.',
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
          vars.businessCategory ? `Category: ${vars.businessCategory}` : '',
        ),
      ),
      section('Competitors', bullets(vars.competitors)),
      section(
        'Keyword gaps (positions; missing means not ranking)',
        vars.keywordGaps?.length ? jsonBlock(vars.keywordGaps.slice(0, 200)) : '',
      ),
      section(
        'Topic coverage (page counts per topic)',
        vars.topicGaps?.length ? jsonBlock(vars.topicGaps.slice(0, 100)) : '',
      ),
      section('Content formats competitors use that we do not', bullets(vars.competitorContentTypes)),
      'Analyse the gaps and prioritise.',
    ),
});
