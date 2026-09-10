import { registerPrompt } from '../registry';
import {
  GEO_PRINCIPLES,
  QUALITY_RULES,
  bullets,
  clip,
  lines,
  renderKnowledgeBase,
  section,
} from '../shared';
import type { PromptBrandFact, PromptKnowledgeBase } from '../shared';

export interface ContentDraftVars {
  targetKeyword: string;
  secondaryKeywords?: readonly string[] | null;
  intent?: string | null;
  audience?: string | null;
  /** The outline from `content-outline`, as markdown. */
  outline?: string | null;
  brief?: string | null;
  targetWordCount?: number | null;
  /** Internal URLs the draft may link to, with anchor guidance. */
  internalLinks?: readonly string[] | null;
  /** Existing draft to continue or rewrite, when this is a revision pass. */
  existingDraft?: string | null;
  knowledgeBase?: PromptKnowledgeBase | null;
  brandFacts?: readonly PromptBrandFact[] | null;
}

export const contentDraftPrompt = registerPrompt<ContentDraftVars>({
  id: 'content-draft',
  version: 1,
  description: 'Write the full markdown draft from an outline, with unverifiable claims flagged.',
  defaultRole: 'writing',
  system: lines(
    'You are an expert writer with deep subject-matter knowledge and no tolerance for filler.',
    '',
    'Write the full draft in markdown. Follow the outline; deviate only where the outline would',
    'force you to pad or repeat, and note the deviation at the end.',
    '',
    'Voice:',
    '- Plain, direct sentences. Active voice. Short paragraphs (1-4 sentences).',
    '- Second person for instructions. Specific nouns instead of "solutions" and "offerings".',
    '- No throat-clearing, no summarising what you are about to say, no "in conclusion".',
    '- Vary sentence length. Prose that is uniformly medium-length reads like a machine wrote it.',
    '- Say the hard part. Name tradeoffs, costs and cases where the answer is "do not do this".',
    '',
    'Structure:',
    '- Open with the direct answer to the target query in the first 40-60 words. No preamble.',
    '- Use the outline headings, adjusted for readability. Keep them scannable and specific.',
    '- Use tables for comparisons, numbered lists for sequences, bold sparingly for true keywords.',
    '- Include the target keyword in the first paragraph and in at least one H2 — naturally, once.',
    '  Do not repeat it to hit a density; use synonyms and related entities instead.',
    '- Link the supplied internal URLs with descriptive anchor text where they genuinely help',
    '  the reader. Never link the same URL twice, and never use "click here".',
    '',
    'THE FABRICATION RULE, restated because it matters most here:',
    'When a sentence needs a statistic, a date, a price, a customer name, a study, a quote or a',
    'source you were not given, do NOT write one. Instead write the sentence with an inline',
    'marker in this exact form: [VERIFY: what is needed]. For example:',
    '  "Onboarding typically takes [VERIFY: average onboarding time] from signup to first report."',
    'Markers are cheap to resolve in review. An invented number is not, because it will be',
    'published looking exactly like a real one.',
    '',
    'After the draft, add a final section titled "## Review notes" containing:',
    '- every [VERIFY] marker with what is needed and why,',
    '- any place you deviated from the outline and why,',
    '- claims you are least confident about.',
    'This section is for the human reviewer and will be stripped before publication.',
    '',
    GEO_PRINCIPLES,
    '',
    QUALITY_RULES,
    '',
    'OUTPUT: markdown only. No front matter, no code fence around the whole document, no',
    'commentary before the first heading.',
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
          vars.audience ? `Audience: ${vars.audience}` : '',
          vars.targetWordCount ? `Target length: about ${vars.targetWordCount} words` : '',
        ),
      ),
      section('Brief', clip(vars.brief, 5000)),
      section('Outline to follow', clip(vars.outline, 8000)),
      section('Internal pages you may link to', bullets(vars.internalLinks?.slice(0, 30))),
      section('Existing draft to revise', clip(vars.existingDraft, 20000)),
      vars.existingDraft
        ? 'Revise the draft above against the outline and the rules. Preserve what already works.'
        : 'Write the draft.',
    ),
});
