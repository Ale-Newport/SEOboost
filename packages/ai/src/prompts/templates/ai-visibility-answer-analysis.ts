import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, bullets, clip, lines, section } from '../shared';

export interface AiVisibilityAnswerAnalysisVars {
  /** The prompt that was asked. */
  prompt: string;
  /** The assistant's verbatim answer. */
  answer: string;
  /** Which assistant produced it, for the record. */
  engine?: string | null;
  brandName: string;
  domain: string;
  competitors?: readonly string[] | null;
  /** Sources the assistant cited, when the engine exposes them. */
  citedUrls?: readonly string[] | null;
}

export const aiVisibilityAnswerAnalysisPrompt = registerPrompt<AiVisibilityAnswerAnalysisVars>({
  id: 'ai-visibility-answer-analysis',
  version: 1,
  description: 'Analyse an AI assistant answer for brand presence, sentiment, accuracy and sources.',
  defaultRole: 'fast',
  system: lines(
    'You analyse one AI assistant answer and report, precisely, how a brand fared in it.',
    '',
    'You are measuring, not judging quality. Report what the answer says, including when it is',
    'unflattering or when the brand is absent. An analysis that softens a bad result destroys',
    'the value of the time series it feeds.',
    '',
    'Report:',
    '- brandMentioned: true only if the brand or its domain is named. Do not count a generic',
    '  description of the category as a mention.',
    '- mentionPosition: ordinal position of the first brand mention among all brands named.',
    '- mentionContext: RECOMMENDED, LISTED_AMONG_OPTIONS, COMPARED_UNFAVOURABLY, MENTIONED_IN',
    '  _PASSING, CAUTIONED_AGAINST or ABSENT.',
    '- sentiment: POSITIVE, NEUTRAL or NEGATIVE, with the quoted sentence that decides it.',
    '- claimsAboutBrand: every factual statement the answer makes about the brand, quoted, each',
    '  marked accurate / inaccurate / unverifiable from your own knowledge — and where you mark',
    '  something inaccurate, say what the answer got wrong. Outdated or wrong claims in',
    '  assistant answers are the highest-priority finding in this whole report.',
    '- competitorsMentioned: each competitor named, its position, and how it was characterised.',
    '- winningAttributes: the specific attributes the answer used to justify whichever options',
    '  it recommended (price, integrations, ease, support, scale). This is the actual content',
    '  gap signal: the brand needs published material on the attributes that decided the answer.',
    '- citedSources: which URLs were cited, whether any belong to this domain, and which',
    '  third-party sources are shaping the answer.',
    '- visibilityGap: one sentence on what would most plausibly have got the brand named here.',
    '',
    'Do not speculate about ranking mechanics or model internals. Analyse only the text given.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Tracking context',
        lines(
          `Brand: ${vars.brandName} (${vars.domain})`,
          vars.engine ? `Assistant: ${vars.engine}` : '',
          vars.competitors?.length ? `Tracked competitors: ${vars.competitors.join(', ')}` : '',
        ),
      ),
      section('Prompt asked', vars.prompt),
      section('Answer received', clip(vars.answer, 30000)),
      section('Sources cited by the assistant', bullets(vars.citedUrls?.slice(0, 30))),
      'Analyse this answer.',
    ),
});
