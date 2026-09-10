import { registerPrompt } from '../registry';
import {
  ANALYSIS_RULES,
  OUTPUT_CONTRACT,
  clip,
  lines,
  renderKnowledgeBase,
  section,
} from '../shared';
import type { PromptBrandFact, PromptKnowledgeBase } from '../shared';

export interface ContentFactCheckVars {
  /** The draft under review, markdown. */
  draft: string;
  targetKeyword?: string | null;
  /** Source material the draft was allowed to draw on, if any. */
  sourceMaterial?: string | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const contentFactCheckPrompt = registerPrompt<ContentFactCheckVars>({
  id: 'content-fact-check',
  version: 1,
  description: 'Audit a draft for unsupported claims, invented figures and prohibited statements.',
  defaultRole: 'reasoning',
  system: lines(
    'You are a fact-checker. You are adversarial by design: assume every specific claim is',
    'wrong until the supplied material supports it.',
    '',
    'Extract every checkable claim in the draft and classify it:',
    '- SUPPORTED: directly backed by the verified brand facts or the supplied source material.',
    '  Quote the supporting text.',
    '- UNSUPPORTED: stated as fact but not present in any supplied material. This includes',
    '  anything that merely sounds like common knowledge. Most fabrications land here.',
    '- CONTRADICTED: conflicts with the verified facts, the knowledge base or another part of',
    '  the same draft. Internal contradictions matter as much as external ones.',
    '- PROHIBITED: violates the prohibited-claims list, or makes a legal, medical, financial,',
    '  safety or guarantee claim the business is not entitled to make.',
    '- NEEDS_ATTRIBUTION: probably true but requires a named source to be publishable.',
    '',
    'Pay particular attention to:',
    '- Numbers of any kind: percentages, counts, prices, durations, dates, versions, ranges.',
    '  A specific number with no source is the highest-risk item on any page.',
    '- Named entities: companies, people, products, studies, standards, laws, awards.',
    '- Superlatives and absolutes: "the only", "the fastest", "always", "guaranteed", "#1".',
    '- Recency claims: "currently", "as of <year>", "the latest", "recently updated".',
    '- Quotes and testimonials, which must never be synthesised.',
    '- [VERIFY: …] markers left by the drafting step — list each one as an open item.',
    '',
    'For each finding give the exact quoted text from the draft, the classification, the',
    'severity (CRITICAL / HIGH / MEDIUM / LOW), why it is a problem, and a concrete suggested',
    'fix (rephrase to a hedge, cite a source, delete, or ask the business for the figure).',
    'Never repair a claim by supplying a number or source of your own.',
    '',
    'Finish with a publishable verdict: PASS, PASS_WITH_EDITS or BLOCK, plus a one-line reason.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      renderKnowledgeBase(vars.knowledgeBase, vars.brandFacts),
      '',
      section('Source material the draft was allowed to use', clip(vars.sourceMaterial, 12000)),
      vars.targetKeyword ? section('Target keyword', `"${vars.targetKeyword}"`) : '',
      section('Draft under review', clip(vars.draft, 40000)),
      'Fact-check the draft above.',
    ),
});
