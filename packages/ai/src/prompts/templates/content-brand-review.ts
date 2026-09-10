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

export interface ContentBrandReviewVars {
  draft: string;
  /** Published pages that exemplify the house voice, so the check has a reference point. */
  voiceExamples?: readonly string[] | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const contentBrandReviewPrompt = registerPrompt<ContentBrandReviewVars>({
  id: 'content-brand-review',
  version: 1,
  description: 'Check a draft against the brand voice, terminology and prohibited claims.',
  defaultRole: 'fast',
  system: lines(
    'You review a draft for brand fit only. Someone else is checking SEO and facts; do not',
    'duplicate their work.',
    '',
    'Score each dimension 0-100 and justify it with quoted evidence from the draft:',
    '- toneMatch: does it sound like this brand, or like generic marketing copy?',
    '- terminology: does it use the brand\'s preferred words for its own concepts? Flag every',
    '  instance of a competitor\'s term, an outdated product name, or a synonym the brand has',
    '  deliberately chosen against.',
    '- audienceFit: is it pitched at the stated audience — their vocabulary, their level, their',
    '  actual concerns? A draft written for a more junior or more senior reader than the brief',
    '  specifies is a real failure, not a nitpick.',
    '- claimsCompliance: does it avoid every prohibited claim, in every wording? Paraphrases of',
    '  a prohibited claim count as violations.',
    '- ctaFit: is the call to action the preferred one, placed where it makes sense?',
    '- consistency: does it describe the products, positioning and differentiators the same way',
    '  the knowledge base does?',
    '',
    'For each issue: the quoted text, the dimension, severity, why it breaks brand, and a',
    'concrete rewrite that fixes it while preserving the author\'s meaning.',
    '',
    'Where no brand guidance exists for something you would otherwise flag, say that the',
    'guidance is missing rather than inventing a rule. That gap is itself worth reporting.',
    '',
    'Finish with an overall verdict: ON_BRAND, MINOR_EDITS or OFF_BRAND.',
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
        'Reference passages in the house voice',
        vars.voiceExamples?.length
          ? vars.voiceExamples
              .slice(0, 5)
              .map((example, index) => `Example ${index + 1}:\n${clip(example, 1500)}`)
              .join('\n\n')
          : '',
      ),
      section('Draft under review', clip(vars.draft, 40000)),
      'Review the draft for brand fit.',
    ),
});
