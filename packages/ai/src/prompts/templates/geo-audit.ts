import { registerPrompt } from '../registry';
import {
  ANALYSIS_RULES,
  GEO_PRINCIPLES,
  OUTPUT_CONTRACT,
  bullets,
  clip,
  lines,
  section,
} from '../shared';

export interface GeoAuditVars {
  url?: string | null;
  title?: string | null;
  content: string;
  /** Schema.org @type values already present on the page. */
  structuredDataTypes?: readonly string[] | null;
  /** Deterministic signals computed by the crawler, so the model does not re-estimate them. */
  wordCount?: number | null;
  headings?: readonly string[] | null;
  hasAuthor?: boolean | null;
  lastModified?: string | null;
  externalLinkDomains?: readonly string[] | null;
  brandName?: string | null;
  targetKeyword?: string | null;
}

export const geoAuditPrompt = registerPrompt<GeoAuditVars>({
  id: 'geo-audit',
  version: 1,
  description: 'Score a page on the eleven GEO dimensions with evidence for each.',
  defaultRole: 'reasoning',
  system: lines(
    'You audit a page for GENERATIVE ENGINE OPTIMISATION: how likely an AI answer engine is to',
    'retrieve, trust and cite it. This is not a classic SEO audit and you must not fall back',
    'into one — meta length and keyword density are not what you are measuring.',
    '',
    'Score each dimension 0-100 and support every score with quoted evidence from the page:',
    '1. entityClarity — are the subject entities named explicitly, consistently and early?',
    '2. structuredData — does the markup describe the page\'s actual content and entities?',
    '3. factDensity — checkable specifics per hundred words: numbers, dates, names, versions.',
    '4. contentStructure — self-contained sections, question-shaped headings, lists, tables.',
    '5. expertiseSignals — named author with credentials, methodology, review date, experience.',
    '6. citationWorthiness — is there a passage an engine would quote verbatim? Identify it.',
    '7. brandConsistency — is the brand and its category described the same way throughout?',
    '8. definitions — does it define its terms in extractable "X is a Y that Z" form?',
    '9. comparativeContent — comparisons, alternatives and tradeoffs, ideally in a table.',
    '10. firstPartyData — original data, benchmarks, experience or examples nobody else has.',
    '11. sourceQuality — are external claims linked to primary, authoritative sources?',
    '',
    'For every dimension also give: the single highest-impact fix, and its effort (LOW/MED/HIGH).',
    '',
    'Then identify:',
    '- quotablePassages: exact passages an engine could lift, with the question each answers.',
    '- missedQuestions: questions in this topic the page fails to answer in extractable form.',
    '- riskFactors: things that would make an engine distrust or skip the page (undated claims,',
    '  contradictions, unattributed statistics, walls of undifferentiated prose).',
    '',
    'Score against what is on the page. Do not assume a signal exists because it usually does,',
    'and do not credit the page for an author byline or a schema type that was not supplied.',
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
        'Page',
        lines(
          vars.url ? `URL: ${vars.url}` : '',
          vars.title ? `Title: ${vars.title}` : '',
          vars.brandName ? `Brand: ${vars.brandName}` : '',
          vars.targetKeyword ? `Target keyword: "${vars.targetKeyword}"` : '',
          vars.wordCount ? `Word count: ${vars.wordCount}` : '',
          vars.hasAuthor === null || vars.hasAuthor === undefined
            ? ''
            : `Author byline detected: ${vars.hasAuthor ? 'yes' : 'no'}`,
          vars.lastModified ? `Last modified: ${vars.lastModified}` : 'Last modified: not published on the page',
          vars.structuredDataTypes?.length
            ? `Schema.org types present: ${vars.structuredDataTypes.join(', ')}`
            : 'Schema.org types present: none',
        ),
      ),
      section('Headings', bullets(vars.headings?.slice(0, 60))),
      section('External domains linked', bullets(vars.externalLinkDomains?.slice(0, 30))),
      section('Content', clip(vars.content, 40000)),
      'Audit this page for GEO.',
    ),
});
