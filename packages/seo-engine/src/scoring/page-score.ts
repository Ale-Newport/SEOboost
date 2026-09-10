import {
  PAGE_SEO_WEIGHTS,
  SEO_THRESHOLDS,
  clamp,
  containsPhrase,
  fleschReadingEase,
  round,
  saturate,
  type ExplainableScore,
  type ScoreFactor,
} from '@seo/shared';

export interface PageScoreInput {
  title: string | null;
  metaDescription: string | null;
  h1: string | null;
  headingCount: number;
  wordCount: number;
  isIndexable: boolean;
  indexabilityReason?: string | null;
  internalLinksIn: number;
  internalLinksOut: number;
  schemaTypes: string[];
  imageCount: number;
  imagesMissingAlt: number;
  openIssues: Array<{ severity: string; weight: number }>;
  targetKeyword?: string | null;
  textContent?: string | null;
  thinContentWords?: number;
}

/**
 * Per-page SEO score, 0-100, from measurable on-page signals only.
 * No AI involved — this must be reproducible and explainable.
 */
export function calculatePageSeoScore(input: PageScoreInput): ExplainableScore {
  const thin = input.thinContentWords ?? SEO_THRESHOLDS.content.thin;
  const factors: ScoreFactor[] = [];

  const add = (key: string, label: string, value: number, explanation: string) => {
    const weight = PAGE_SEO_WEIGHTS[key as keyof typeof PAGE_SEO_WEIGHTS];
    factors.push({
      key,
      label,
      value: clamp(value),
      weight,
      contribution: round(clamp(value) * weight * 100, 2),
      explanation,
    });
  };

  // Title
  const title = input.title?.trim() ?? '';
  if (!title) {
    add('title', 'Title tag', 0, 'No title tag.');
  } else {
    const len = title.length;
    const lengthScore =
      len >= SEO_THRESHOLDS.title.min && len <= SEO_THRESHOLDS.title.max
        ? 1
        : len < SEO_THRESHOLDS.title.min
          ? clamp(len / SEO_THRESHOLDS.title.min) * 0.8
          : clamp(1 - (len - SEO_THRESHOLDS.title.max) / 40) * 0.8;
    const keywordBonus = input.targetKeyword && containsPhrase(title, input.targetKeyword) ? 1 : 0.8;
    add(
      'title',
      'Title tag',
      lengthScore * keywordBonus,
      `${len} characters${
        input.targetKeyword
          ? containsPhrase(title, input.targetKeyword)
            ? ', contains the target keyword'
            : ', missing the target keyword'
          : ''
      }.`,
    );
  }

  // Meta description
  const desc = input.metaDescription?.trim() ?? '';
  if (!desc) {
    add('metaDescription', 'Meta description', 0, 'No meta description.');
  } else {
    const len = desc.length;
    const score =
      len >= SEO_THRESHOLDS.metaDescription.min && len <= SEO_THRESHOLDS.metaDescription.max
        ? 1
        : len < SEO_THRESHOLDS.metaDescription.min
          ? clamp(len / SEO_THRESHOLDS.metaDescription.min) * 0.85
          : clamp(1 - (len - SEO_THRESHOLDS.metaDescription.max) / 60) * 0.85;
    add('metaDescription', 'Meta description', score, `${len} characters.`);
  }

  // Headings
  const hasH1 = Boolean(input.h1?.trim());
  const structureScore = clamp((hasH1 ? 0.6 : 0) + saturate(input.headingCount, 6) * 0.4);
  add(
    'headings',
    'Heading structure',
    structureScore,
    hasH1
      ? `H1 present with ${input.headingCount} heading${input.headingCount === 1 ? '' : 's'} total.`
      : `No H1; ${input.headingCount} heading${input.headingCount === 1 ? '' : 's'} found.`,
  );

  // Content depth (+ readability nudge when we have the text)
  const depthScore = clamp(input.wordCount / (thin * 3));
  let contentScore = depthScore;
  let contentExplanation = `${input.wordCount} words (${thin} is the thin-content threshold for this site).`;
  if (input.textContent && input.wordCount > 100) {
    const readability = fleschReadingEase(input.textContent);
    // Reward the 45-75 band: readable without being simplistic. Outside it, a mild penalty.
    const readabilityFactor = readability >= 45 && readability <= 80 ? 1 : 0.9;
    contentScore = clamp(depthScore * readabilityFactor);
    contentExplanation += ` Reading ease ${readability}.`;
  }
  add('contentDepth', 'Content depth', contentScore, contentExplanation);

  // Indexability is close to binary — a non-indexable page cannot rank.
  add(
    'indexability',
    'Indexability',
    input.isIndexable ? 1 : 0,
    input.isIndexable ? 'Indexable.' : `Not indexable: ${input.indexabilityReason ?? 'unknown reason'}.`,
  );

  // Internal links
  const inboundScore = saturate(input.internalLinksIn, 8);
  const outboundScore = input.internalLinksOut > 0 ? 1 : 0.4;
  add(
    'internalLinks',
    'Internal links',
    clamp(inboundScore * 0.75 + outboundScore * 0.25),
    `${input.internalLinksIn} inbound, ${input.internalLinksOut} outbound internal links.`,
  );

  // Structured data
  const schemaScore = input.schemaTypes.length === 0 ? 0 : clamp(0.6 + saturate(input.schemaTypes.length, 2) * 0.4);
  add(
    'structuredData',
    'Structured data',
    schemaScore,
    input.schemaTypes.length ? `Schema types: ${input.schemaTypes.slice(0, 5).join(', ')}.` : 'No structured data.',
  );

  // Images
  const imageScore =
    input.imageCount === 0 ? 0.7 : clamp(1 - input.imagesMissingAlt / Math.max(1, input.imageCount));
  add(
    'images',
    'Images',
    imageScore,
    input.imageCount === 0
      ? 'No images on the page.'
      : `${input.imagesMissingAlt} of ${input.imageCount} images missing alt text.`,
  );

  // Open technical issues on this URL
  const issuePenalty = input.openIssues.reduce((total, issue) => {
    const severityWeight =
      issue.severity === 'CRITICAL' ? 4 : issue.severity === 'HIGH' ? 2.5 : issue.severity === 'MEDIUM' ? 1.2 : 0.4;
    return total + severityWeight * (issue.weight || 1);
  }, 0);
  add(
    'technicalIssues',
    'Technical issues',
    clamp(1 - saturate(issuePenalty, 6)),
    input.openIssues.length === 0
      ? 'No open technical issues on this URL.'
      : `${input.openIssues.length} open technical issue${input.openIssues.length === 1 ? '' : 's'}.`,
  );

  const score = round(
    factors.reduce((total, f) => total + f.value * f.weight, 0) * 100,
    1,
  );
  const weakest = [...factors].sort((a, b) => a.value * a.weight - b.value * b.weight)[0];

  return {
    score,
    factors,
    summary: weakest
      ? `Biggest gap: ${weakest.label.toLowerCase()} — ${weakest.explanation}`
      : 'All measured on-page signals look healthy.',
  };
}
