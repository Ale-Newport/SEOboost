import { registerPrompt } from '../registry';
import {
  ANALYSIS_RULES,
  GEO_PRINCIPLES,
  OUTPUT_CONTRACT,
  bullets,
  clip,
  jsonBlock,
  lines,
  section,
} from '../shared';

export interface GeoDimensionScore {
  dimension: string;
  score: number;
  evidence?: string | null;
}

export interface GeoRecommendationsVars {
  url?: string | null;
  title?: string | null;
  /** Scores from `geo-audit`, so recommendations attack the weakest dimensions first. */
  dimensionScores: readonly GeoDimensionScore[];
  overallScore?: number | null;
  content?: string | null;
  missedQuestions?: readonly string[] | null;
  structuredDataTypes?: readonly string[] | null;
  /** How the site is currently described in AI answers, when tracking data exists. */
  observedAiMentions?: readonly string[] | null;
  maxRecommendations?: number | null;
}

export const geoRecommendationsPrompt = registerPrompt<GeoRecommendationsVars>({
  id: 'geo-recommendations',
  version: 1,
  description: 'Turn GEO audit scores into ranked, concrete, applyable recommendations.',
  defaultRole: 'reasoning',
  system: lines(
    'You convert a GEO audit into work someone can actually do this week.',
    '',
    'A recommendation that says "improve entity clarity" is worthless. Every recommendation must',
    'name the exact change: the passage to rewrite (quoted), the sentence to add and roughly',
    'where, the schema property to emit, the table to build. If you cannot be that specific,',
    'the recommendation is not ready and you should drop it.',
    '',
    'Rank by expected impact per unit of effort, not by dimension score alone: a 20-point gap on',
    'a low-weight dimension that takes ten minutes usually beats a 40-point gap that needs new',
    'original research. Say which is which.',
    '',
    'For each recommendation give:',
    '- dimension it targets and the current score.',
    '- action: one imperative sentence.',
    '- currentState: quoted evidence of the problem, or an explicit note that the element is absent.',
    '- proposedChange: the actual replacement text, structure or markup. Write it out.',
    '- rationale: the mechanism by which this raises citation probability, in one sentence.',
    '- effort: LOW (under 30 min), MEDIUM (a few hours), HIGH (needs new research or data).',
    '- expectedImpact: HIGH/MEDIUM/LOW, with the reasoning.',
    '- requiresHumanInput: true when the change needs a fact, figure, quote or credential the',
    '  business must supply. Name exactly what is needed. Never fill the gap yourself.',
    '- autoApplicable: true only when the change cannot alter the meaning of existing copy.',
    '',
    'Where the highest-value move is genuinely "publish original data you do not have yet", say',
    'that plainly as a HIGH-effort recommendation rather than substituting a cosmetic fix.',
    '',
    GEO_PRINCIPLES,
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
          vars.url ? `URL: ${vars.url}` : '',
          vars.title ? `Title: ${vars.title}` : '',
          vars.overallScore !== null && vars.overallScore !== undefined
            ? `Overall GEO score: ${vars.overallScore}`
            : '',
          vars.structuredDataTypes?.length
            ? `Schema.org types present: ${vars.structuredDataTypes.join(', ')}`
            : 'Schema.org types present: none',
        ),
      ),
      section('Dimension scores from the audit', jsonBlock(vars.dimensionScores)),
      section('Questions the page fails to answer in extractable form', bullets(vars.missedQuestions)),
      section('How AI assistants currently describe this site', bullets(vars.observedAiMentions?.slice(0, 20))),
      section('Page content', clip(vars.content, 30000)),
      `Return at most ${vars.maxRecommendations ?? 12} recommendations, highest value first.`,
    ),
});
