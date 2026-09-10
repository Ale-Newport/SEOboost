import { registerPrompt } from '../registry';
import {
  GEO_PRINCIPLES,
  OUTPUT_CONTRACT,
  QUALITY_RULES,
  bullets,
  clip,
  lines,
  renderKnowledgeBase,
  section,
} from '../shared';
import type { PromptBrandFact, PromptKnowledgeBase } from '../shared';

export interface ContentBriefCompetitor {
  url: string;
  title?: string | null;
  headings?: readonly string[] | null;
  wordCount?: number | null;
}

export interface ContentBriefVars {
  siteName: string;
  domain: string;
  targetKeyword: string;
  secondaryKeywords?: readonly string[] | null;
  intent?: string | null;
  funnelStage?: string | null;
  contentType?: string | null;
  audience?: string | null;
  /** Pages currently ranking, used to establish the bar rather than to copy. */
  competitors?: readonly ContentBriefCompetitor[] | null;
  /** Questions from People Also Ask, GSC queries, or support tickets. */
  questions?: readonly string[] | null;
  /** Internal URLs the finished piece should link to. */
  internalLinkTargets?: readonly string[] | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const contentBriefPrompt = registerPrompt<ContentBriefVars>({
  id: 'content-brief',
  version: 1,
  description: 'Produce a writer-ready content brief: angle, must-cover points, structure, links.',
  defaultRole: 'reasoning',
  system: lines(
    'You are a content strategist writing a brief that a competent writer can execute without',
    'asking you a single follow-up question.',
    '',
    'A brief that merely lists what competitors covered produces a page that deserves to rank',
    'fourth. Your job is to identify the angle that makes this piece the best answer available:',
    'the first-party experience, data, opinion or specificity that nobody ranking today has.',
    'If the supplied knowledge base gives you nothing to differentiate with, say so explicitly',
    'in `differentiationRisk` rather than papering over it.',
    '',
    'The brief must specify:',
    '- angle: the one-sentence thesis, and why a reader would choose this over what ranks now.',
    '- searcherJob: what the reader is actually trying to accomplish, in their words.',
    '- mustCoverPoints: the substantive points required for completeness, each with why it',
    '  matters. Not a heading list — the argument.',
    '- questionsToAnswer: the explicit questions the page must answer, phrased as a searcher',
    '  would ask them, so they can become H2s and get lifted into AI answers.',
    '- entitiesToMention: people, products, standards, tools, places the page should name.',
    '- structure: recommended sections with a target depth for each.',
    '- targetWordCount: a range, justified by the depth the intent needs rather than by',
    '  outdoing a competitor word count.',
    '- internalLinks: which supplied internal URLs to link and the reason for each.',
    '- factsNeeded: specific facts, figures or examples the writer must obtain from the',
    '  business. This list is how the piece gets written without inventing anything.',
    '- eeatSignals: author expertise, methodology or evidence the page should display.',
    '- successCriteria: how to tell afterwards whether this piece worked.',
    '',
    GEO_PRINCIPLES,
    '',
    QUALITY_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      renderKnowledgeBase(vars.knowledgeBase, vars.brandFacts),
      '',
      section(
        'Assignment',
        lines(
          `Site: ${vars.siteName} (${vars.domain})`,
          `Primary keyword: "${vars.targetKeyword}"`,
          vars.secondaryKeywords?.length
            ? `Secondary keywords: ${vars.secondaryKeywords.join(', ')}`
            : '',
          vars.intent ? `Intent: ${vars.intent}` : '',
          vars.funnelStage ? `Funnel stage: ${vars.funnelStage}` : '',
          vars.contentType ? `Format: ${vars.contentType}` : '',
          vars.audience ? `Audience: ${vars.audience}` : '',
        ),
      ),
      section(
        'What currently ranks (the bar to clear, not a template to copy)',
        vars.competitors?.length
          ? vars.competitors
              .map((competitor) =>
                lines(
                  `- ${competitor.url}`,
                  competitor.title ? `  title: ${competitor.title}` : '',
                  competitor.wordCount ? `  length: ${competitor.wordCount} words` : '',
                  competitor.headings?.length
                    ? `  headings: ${clip(competitor.headings.join(' > '), 800)}`
                    : '',
                ),
              )
              .join('\n')
          : 'No competitor data was supplied. Do not speculate about what ranks.',
      ),
      section('Questions readers ask about this topic', bullets(vars.questions?.slice(0, 25))),
      section('Internal pages available to link to', bullets(vars.internalLinkTargets?.slice(0, 40))),
      'Write the brief.',
    ),
});
