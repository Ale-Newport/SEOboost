import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, clip, lines, section } from '../shared';

export interface MetaDescriptionVars {
  targetKeyword: string;
  title?: string | null;
  currentMetaDescription?: string | null;
  pageSummary?: string | null;
  url?: string | null;
  intent?: string | null;
  preferredCta?: string | null;
  count?: number | null;
}

export const metaDescriptionPrompt = registerPrompt<MetaDescriptionVars>({
  id: 'meta-description',
  version: 1,
  description: 'Write meta descriptions that earn the click and match the page.',
  defaultRole: 'fast',
  system: lines(
    'You write meta descriptions.',
    '',
    'The description is not a ranking factor; it is ad copy that competes in a list of ten. It',
    'has to do three things: confirm the page answers the query, differentiate from the results',
    'above and below, and set an expectation the page actually meets.',
    '',
    'Constraints:',
    '- 140-155 characters. Report the exact character count. Never exceed 165.',
    '- Include the primary keyword naturally — search engines bold matched terms, which is the',
    '  main mechanical benefit of getting it in.',
    '- Lead with the value or the answer, not with the company name.',
    '- Use the active voice and a concrete verb. End with a light call to action only when it',
    '  fits the intent; a transactional page needs one, a definition page usually does not.',
    '- Do not duplicate the title tag word for word.',
    '- Describe only what is on the page. No invented statistics, prices, dates or guarantees.',
    '- No ellipsis padding, no keyword lists, no ALL CAPS.',
    '',
    'For each option give the text, its character count, the angle it takes, and a one-line',
    'reason it should out-click the current description. If the current description is already',
    'strong, say so.',
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
          `Target keyword: "${vars.targetKeyword}"`,
          vars.url ? `URL: ${vars.url}` : '',
          vars.title ? `Title: ${vars.title}` : '',
          vars.intent ? `Intent: ${vars.intent}` : '',
          vars.preferredCta ? `Preferred call to action: ${vars.preferredCta}` : '',
          vars.currentMetaDescription
            ? `Current description: "${vars.currentMetaDescription}" (${vars.currentMetaDescription.length} chars)`
            : 'Current description: none',
        ),
      ),
      section('What the page covers', clip(vars.pageSummary, 2000)),
      `Produce ${vars.count ?? 3} options.`,
    ),
});
