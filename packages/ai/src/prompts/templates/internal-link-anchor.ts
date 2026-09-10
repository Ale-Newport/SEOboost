import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, clip, lines, section } from '../shared';

export interface InternalLinkCandidate {
  targetUrl: string;
  targetTitle?: string | null;
  targetKeyword?: string | null;
  targetSummary?: string | null;
  /** Vector similarity between source and target, when available. */
  similarity?: number | null;
  /** Anchors already pointing at this target from elsewhere, to keep the profile varied. */
  existingAnchors?: readonly string[] | null;
}

export interface InternalLinkAnchorVars {
  sourceUrl: string;
  sourceTitle?: string | null;
  /** The passage(s) where a link could be placed, markdown or text. */
  sourceContent: string;
  candidates: readonly InternalLinkCandidate[];
  maxLinks?: number | null;
}

export const internalLinkAnchorPrompt = registerPrompt<InternalLinkAnchorVars>({
  id: 'internal-link-anchor',
  version: 1,
  description: 'Pick internal link placements and natural anchor text inside existing copy.',
  defaultRole: 'fast',
  system: lines(
    'You place internal links inside copy that already exists.',
    '',
    'The hard rule: you may only propose an anchor that is EXACTLY a substring of the supplied',
    'source content, quoted character for character. The applier performs a literal string',
    'replacement, so an anchor you paraphrased will silently fail to apply or will corrupt the',
    'sentence. If no suitable phrase exists in the text, propose no link for that target and say',
    'why — that is the correct answer, not a reason to invent one.',
    '',
    'Choose placements where the link genuinely helps the reader continue: the sentence should',
    'raise the question the target page answers. A link that interrupts a sentence to reach a',
    'quota is worse than no link.',
    '',
    'Anchor text guidance:',
    '- 2-6 words, descriptive of the destination, readable in the sentence as written.',
    '- Vary anchors across the site. Repeating the target keyword as an exact-match anchor on',
    '  every link looks manipulative and flattens the signal; include the existing anchors when',
    '  judging this.',
    '- Never "click here", "this page", "read more", or a bare URL.',
    '- Do not link the same target twice from one page, and do not link a phrase already inside',
    '  another link or a heading.',
    '',
    'For each proposal give: targetUrl, the exact anchor substring, roughly 60 characters of the',
    'surrounding text so a human can locate it, a relevance score 0-1, and the reason a reader',
    'at that point would want the target page.',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Source page',
        lines(`URL: ${vars.sourceUrl}`, vars.sourceTitle ? `Title: ${vars.sourceTitle}` : ''),
      ),
      section(
        'Link targets to consider',
        vars.candidates
          .map((candidate) =>
            lines(
              `- ${candidate.targetUrl}`,
              candidate.targetTitle ? `  title: ${candidate.targetTitle}` : '',
              candidate.targetKeyword ? `  target keyword: "${candidate.targetKeyword}"` : '',
              candidate.similarity !== null && candidate.similarity !== undefined
                ? `  similarity: ${candidate.similarity.toFixed(2)}`
                : '',
              candidate.targetSummary ? `  covers: ${clip(candidate.targetSummary, 300)}` : '',
              candidate.existingAnchors?.length
                ? `  anchors already used elsewhere: ${candidate.existingAnchors.slice(0, 8).join(' | ')}`
                : '',
            ),
          )
          .join('\n'),
      ),
      section('Source content — anchors must be exact substrings of this text', clip(vars.sourceContent, 30000)),
      `Propose at most ${vars.maxLinks ?? 5} links.`,
    ),
});
