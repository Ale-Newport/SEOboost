import { registerPrompt } from '../registry';
import {
  ANALYSIS_RULES,
  OUTPUT_CONTRACT,
  bullets,
  jsonBlock,
  lines,
  renderKnowledgeBase,
  section,
} from '../shared';
import type { PromptBrandFact, PromptKnowledgeBase } from '../shared';

export interface SeoManagerStrategyVars {
  siteName: string;
  domain: string;
  businessCategory?: string | null;
  conversionGoal?: string | null;
  /** Rolled-up scores from the analysis pipeline. */
  scores?: Readonly<Record<string, number | null>> | null;
  /** Issue counts by severity, from the technical audit. */
  issueCounts?: Readonly<Record<string, number>> | null;
  /** Period-over-period traffic and ranking movement, already computed. */
  performanceDeltas?: Readonly<Record<string, number | null>> | null;
  topOpportunities?: readonly string[] | null;
  recentActions?: readonly string[] | null;
  /** What the operator has authorised the platform to do without approval. */
  autonomyLevel?: string | null;
  /** Practical limits: hours per week, budget, publishing capacity. */
  constraints?: readonly string[] | null;
  horizonWeeks?: number | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const seoManagerStrategyPrompt = registerPrompt<SeoManagerStrategyVars>({
  id: 'seo-manager-strategy',
  version: 1,
  description: 'Set the site strategy and sequenced plan from the current state of the data.',
  defaultRole: 'reasoning',
  system: lines(
    'You are the SEO lead for this site. You decide what the team does next and in what order,',
    'and you are accountable for the result.',
    '',
    'Sequencing is the whole job. Technical blockers that suppress indexing come before content',
    'investment, because content on an unindexable site earns nothing. Fixing a page that',
    'already ranks 8-20 beats writing a new one, because the ranking signal already exists.',
    'Consolidating cannibalising pages beats adding a third. State the dependency whenever one',
    'exists — "do B only after A" is more valuable than a flat list of good ideas.',
    '',
    'Produce:',
    '- situationAssessment: what the data actually says, in three or four sentences, including',
    '  what is going wrong. No reassurance.',
    '- strategicFocus: the one theme for this horizon, and explicitly what you are NOT doing.',
    '- priorities: an ordered list. Each with the action, the rationale tied to a specific',
    '  number in the input, the expected outcome, the effort, the owner type (AUTOMATED,',
    '  HUMAN_REVIEW or HUMAN_ONLY) and any dependency on an earlier priority.',
    '- quickWins: changes deliverable this week with disproportionate value.',
    '- risks: what could go wrong, including risk created by the plan itself (a consolidation',
    '  that loses rankings, a redirect chain, a publishing cadence the team cannot sustain).',
    '- measurement: the specific metrics to watch and when to expect movement. Be honest that',
    '  most SEO changes take weeks to read; do not promise a signal that will not exist.',
    '- needsHumanDecision: choices you should not make alone — anything involving redirects,',
    '  deletions, pricing, legal or brand positioning.',
    '',
    'Respect the stated autonomy level and constraints. A plan the team cannot execute at its',
    'actual capacity is a worse plan, not a more ambitious one.',
    '',
    'Ground every claim in the supplied numbers. Do not invent traffic, revenue, competitor',
    'behaviour or industry benchmarks, and do not cite a study you cannot name.',
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
          `${vars.siteName} (${vars.domain})`,
          vars.businessCategory ? `Category: ${vars.businessCategory}` : '',
          vars.conversionGoal ? `Conversion goal: ${vars.conversionGoal}` : '',
          vars.autonomyLevel ? `Autonomy level: ${vars.autonomyLevel}` : '',
          `Planning horizon: ${vars.horizonWeeks ?? 12} weeks`,
        ),
      ),
      section('Current scores', vars.scores ? jsonBlock(vars.scores) : ''),
      section('Open issues by severity', vars.issueCounts ? jsonBlock(vars.issueCounts) : ''),
      section(
        'Performance change vs previous period',
        vars.performanceDeltas ? jsonBlock(vars.performanceDeltas) : '',
      ),
      section('Opportunities surfaced by the analysis pipeline', bullets(vars.topOpportunities?.slice(0, 40))),
      section('Actions already taken recently', bullets(vars.recentActions?.slice(0, 30))),
      section('Constraints', bullets(vars.constraints)),
      'Set the strategy and the sequenced plan.',
    ),
});
