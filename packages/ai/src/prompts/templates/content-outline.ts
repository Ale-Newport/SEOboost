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

export interface ContentOutlineVars {
  targetKeyword: string;
  secondaryKeywords?: readonly string[] | null;
  intent?: string | null;
  contentType?: string | null;
  /** The brief produced by `content-brief`, as markdown or plain text. */
  brief?: string | null;
  angle?: string | null;
  questionsToAnswer?: readonly string[] | null;
  mustCoverPoints?: readonly string[] | null;
  targetWordCount?: number | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const contentOutlinePrompt = registerPrompt<ContentOutlineVars>({
  id: 'content-outline',
  version: 1,
  description: 'Turn a brief into a section-by-section outline with headings and word budgets.',
  defaultRole: 'writing',
  system: lines(
    'You turn a brief into an outline a writer can draft straight from.',
    '',
    'Two structural rules dominate everything else:',
    '1. The page must answer the primary question in the first 40-60 words, before any',
    '   scene-setting. Your first section is that answer, not an introduction.',
    '2. Each H2 is a self-contained passage that answers one question completely. That is the',
    '   unit search engines rank and AI answer engines quote, so a section that only makes',
    '   sense after reading the previous one is a structural defect.',
    '',
    'For every section give: heading (H2/H3, phrased the way a searcher would ask it), the',
    'question it answers, the key points to make, the evidence or example needed, an approximate',
    'word budget, and any element that belongs there (table, list, code block, image, callout).',
    '',
    'Also decide:',
    '- Where a comparison table or a step list would carry the information better than prose.',
    '- Which sections need a fact the business must supply, and flag them.',
    '- A logical order: what the reader must understand before the next section makes sense.',
    '- Where the natural call to action sits, if any — do not bolt one onto every section.',
    '',
    'Do not write the prose. Do not invent facts, figures or examples to fill a section; if a',
    'section needs evidence you do not have, say what evidence is needed.',
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
          `Primary keyword: "${vars.targetKeyword}"`,
          vars.secondaryKeywords?.length
            ? `Secondary keywords: ${vars.secondaryKeywords.join(', ')}`
            : '',
          vars.intent ? `Intent: ${vars.intent}` : '',
          vars.contentType ? `Format: ${vars.contentType}` : '',
          vars.angle ? `Angle: ${vars.angle}` : '',
          vars.targetWordCount ? `Target length: about ${vars.targetWordCount} words` : '',
        ),
      ),
      section('Brief', clip(vars.brief, 6000)),
      section('Must-cover points', bullets(vars.mustCoverPoints)),
      section('Questions the page must answer', bullets(vars.questionsToAnswer)),
      'Produce the outline.',
    ),
});
