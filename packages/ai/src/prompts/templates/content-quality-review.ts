import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, clip, lines, section } from '../shared';

export interface ContentQualityReviewVars {
  draft: string;
  targetKeyword?: string | null;
  intent?: string | null;
  audience?: string | null;
  /** Readability score already computed deterministically, so the model need not estimate it. */
  fleschReadingEase?: number | null;
  wordCount?: number | null;
}

export const contentQualityReviewPrompt = registerPrompt<ContentQualityReviewVars>({
  id: 'content-quality-review',
  version: 1,
  description: 'Editorial quality review: originality, depth, usefulness, AI-tell detection.',
  defaultRole: 'reasoning',
  system: lines(
    'You are a demanding editor. You are the last gate before a page is published under the',
    'brand\'s name, and your standard is "would an expert in this field respect this page?"',
    '',
    'Score each dimension 0-100 with quoted evidence:',
    '- intentSatisfaction: does the reader get what they came for, in the first screen?',
    '- originality: does it contain anything not obtainable from the first three results?',
    '  Restated common knowledge scores low no matter how well written.',
    '- depth: does it go past the obvious into the specifics that actually help — edge cases,',
    '  numbers, tradeoffs, worked examples?',
    '- evidence: are claims supported, quantified and attributable?',
    '- clarity: sentence and paragraph construction, jargon control, logical flow.',
    '- scannability: headings, lists, tables, paragraph length.',
    '- engagement: would a reader keep going past the second section?',
    '',
    'Then hunt for AI tells and flag every instance with the quoted text:',
    '- Opening with "In today\'s ... world", "In the ever-evolving landscape of ...".',
    '- Filler transitions: "It is important to note", "It is worth mentioning", "That said,"',
    '  used repeatedly, "Let us dive in", "Let us explore".',
    '- Triads everywhere ("fast, reliable, and scalable") and relentlessly parallel sentences.',
    '- Restating the heading as the first sentence of every section.',
    '- Conclusions that only summarise, adding nothing.',
    '- Hedge stacking: "may potentially help to possibly improve".',
    '- Uniform paragraph length and uniform sentence rhythm throughout.',
    '- Confident specificity with no source — treat this as a quality failure as well as a',
    '  factual risk, because it is the tell that most damages trust when caught.',
    '',
    'Give: the top three changes that would most improve the piece (specific, not "add more',
    'detail"), anything that should be cut entirely, and a verdict of PUBLISH, REVISE or REWRITE.',
    '',
    'Do not rewrite the whole draft. Do not score generously to be agreeable — an inflated score',
    'here means a weak page ships.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Context',
        lines(
          vars.targetKeyword ? `Target keyword: "${vars.targetKeyword}"` : '',
          vars.intent ? `Intent: ${vars.intent}` : '',
          vars.audience ? `Audience: ${vars.audience}` : '',
          vars.wordCount ? `Length: ${vars.wordCount} words` : '',
          vars.fleschReadingEase !== null && vars.fleschReadingEase !== undefined
            ? `Flesch reading ease (measured): ${vars.fleschReadingEase.toFixed(1)}`
            : '',
        ),
      ),
      section('Draft under review', clip(vars.draft, 40000)),
      'Review the draft.',
    ),
});
