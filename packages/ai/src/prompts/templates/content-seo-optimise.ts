import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, GEO_PRINCIPLES, OUTPUT_CONTRACT, bullets, clip, lines, section } from '../shared';

export interface ContentSeoOptimiseVars {
  draft: string;
  targetKeyword: string;
  secondaryKeywords?: readonly string[] | null;
  intent?: string | null;
  currentTitle?: string | null;
  currentMetaDescription?: string | null;
  url?: string | null;
  /** Internal URLs available to link, so link suggestions are real rather than invented. */
  internalLinkTargets?: readonly string[] | null;
  /** Entities competitors cover that this draft may be missing. */
  competitorEntities?: readonly string[] | null;
}

export const contentSeoOptimisePrompt = registerPrompt<ContentSeoOptimiseVars>({
  id: 'content-seo-optimise',
  version: 1,
  description: 'Suggest on-page SEO and GEO improvements to a draft without degrading the writing.',
  defaultRole: 'reasoning',
  system: lines(
    'You optimise an already-written draft for search and for AI answer engines.',
    '',
    'The constraint that makes this useful: never suggest a change that makes the page worse to',
    'read. Keyword insertion that damages a sentence loses more than the ranking it buys, and',
    'reviewers correctly reject it. If the draft is already well optimised, say so and return',
    'few or no suggestions — an empty list is a legitimate and valuable result.',
    '',
    'Review, in priority order:',
    '1. Intent match — does the opening answer the query in the first 40-60 words?',
    '2. Heading structure — one H1, descriptive H2s phrased as questions, correct nesting, no',
    '   skipped levels, headings that make sense read on their own.',
    '3. Keyword coverage — the primary term used naturally in the opening and one heading;',
    '   secondary terms and semantic variants present where they fit. Flag OVER-optimisation',
    '   (repetition, exact-match stuffing, unnatural phrasing) as loudly as under-optimisation.',
    '4. Entity and topical coverage — subtopics or entities a complete answer needs and this',
    '   draft omits. Only name entities you can justify from the supplied material.',
    '5. Extractability — passages an answer engine could lift verbatim: definition sentences,',
    '   direct answers, comparison tables, step lists.',
    '6. Internal links — which supplied URLs to link, with the anchor text to use and where.',
    '   Never invent a URL that was not supplied.',
    '7. Title and meta description — flag when the current ones under-sell or mismatch.',
    '8. Scannability — paragraph length, list use, table opportunities.',
    '',
    'For every suggestion give: the category, the exact current text (quoted) when there is one,',
    'the proposed replacement, the reason, an impact estimate (HIGH/MEDIUM/LOW) and whether it',
    'can be applied automatically or needs a human. Automatic application must be limited to',
    'changes that cannot alter meaning.',
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
        'Target',
        lines(
          `Primary keyword: "${vars.targetKeyword}"`,
          vars.secondaryKeywords?.length
            ? `Secondary keywords: ${vars.secondaryKeywords.join(', ')}`
            : '',
          vars.intent ? `Intent: ${vars.intent}` : '',
          vars.url ? `URL: ${vars.url}` : '',
          vars.currentTitle ? `Current title: ${vars.currentTitle}` : '',
          vars.currentMetaDescription
            ? `Current meta description: ${vars.currentMetaDescription}`
            : '',
        ),
      ),
      section('Internal pages available to link to', bullets(vars.internalLinkTargets?.slice(0, 40))),
      section(
        'Entities covered by pages that outrank this one',
        bullets(vars.competitorEntities?.slice(0, 40)),
      ),
      section('Draft', clip(vars.draft, 40000)),
      'Return your optimisation suggestions.',
    ),
});
