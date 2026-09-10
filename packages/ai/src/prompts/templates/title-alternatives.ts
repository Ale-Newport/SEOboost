import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, bullets, clip, lines, section } from '../shared';

export interface TitleAlternativesVars {
  targetKeyword: string;
  currentTitle?: string | null;
  pageSummary?: string | null;
  url?: string | null;
  brandName?: string | null;
  intent?: string | null;
  /** Titles ranking for the term — used to find an angle none of them takes. */
  competitorTitles?: readonly string[] | null;
  /** Measured CTR and position, so the model knows whether the current title underperforms. */
  currentCtr?: number | null;
  expectedCtr?: number | null;
  currentPosition?: number | null;
  count?: number | null;
}

export const titleAlternativesPrompt = registerPrompt<TitleAlternativesVars>({
  id: 'title-alternatives',
  version: 1,
  description: 'Generate title tag alternatives that raise click-through without over-promising.',
  defaultRole: 'fast',
  system: lines(
    'You write title tags. A title has one job: earn the click from someone who will be glad',
    'they clicked. A title that wins the click and disappoints the reader costs more than it',
    'earns, because the bounce is measured too.',
    '',
    'Constraints:',
    '- 50-60 characters is the target; 70 is the hard ceiling before truncation. Report the',
    '  exact character count for every option.',
    '- The primary keyword goes near the front, phrased naturally.',
    '- Append " | Brand" only when the brand adds trust or the character budget allows it.',
    '- Every title must be truthful about what the page actually contains.',
    '- No clickbait, no fake urgency, no "You Won\'t Believe", no invented years or numbers.',
    '  Never write "2026" unless the page is genuinely year-specific and current.',
    '',
    'Vary the angle across options rather than rewording one idea. Useful angles: direct answer,',
    'benefit-led, specificity/number (only if the number is real and in the page), comparison,',
    'question form, audience-qualified, speed or effort ("in 10 minutes"), authority.',
    '',
    'For each option give: the title, its character count, the angle, why it might beat the',
    'current title, and a risk note if it could over-promise. Rank them, best first, and be',
    'explicit when the current title is already strong — recommending no change is a valid result.',
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
          vars.currentTitle
            ? `Current title: "${vars.currentTitle}" (${vars.currentTitle.length} chars)`
            : 'Current title: none',
          vars.brandName ? `Brand: ${vars.brandName}` : '',
          vars.intent ? `Intent: ${vars.intent}` : '',
        ),
      ),
      section(
        'Measured performance',
        lines(
          vars.currentPosition ? `Average position: ${vars.currentPosition.toFixed(1)}` : '',
          vars.currentCtr !== null && vars.currentCtr !== undefined
            ? `Actual CTR: ${(vars.currentCtr * 100).toFixed(2)}%`
            : '',
          vars.expectedCtr !== null && vars.expectedCtr !== undefined
            ? `Expected CTR for this position: ${(vars.expectedCtr * 100).toFixed(2)}%`
            : '',
        ),
      ),
      section('What the page covers', clip(vars.pageSummary, 2000)),
      section('Titles currently ranking for this keyword', bullets(vars.competitorTitles?.slice(0, 10))),
      `Produce ${vars.count ?? 5} alternatives.`,
    ),
});
