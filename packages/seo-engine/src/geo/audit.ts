import {
  GEO_DIMENSION_LABELS,
  GEO_DIMENSION_WEIGHTS,
  clamp,
  containsPhrase,
  round,
  saturate,
  splitSentences,
  tokenize,
  type ExplainableScore,
  type ScoreFactor,
} from '@seo/shared';

export interface GeoPageInput {
  id: string;
  url: string;
  title: string | null;
  h1: string | null;
  metaDescription: string | null;
  textContent: string | null;
  html?: string | null;
  wordCount: number;
  headings: Array<{ level: number; text: string }>;
  schemaTypes: string[];
  structuredData: unknown[];
  externalLinks: Array<{ href: string; anchorText: string; isNofollow: boolean }>;
  pageType: string;
  isIndexable: boolean;
}

export interface GeoSiteContext {
  brandName: string | null;
  domain: string;
  /** Descriptions of the brand found across the site, used for consistency checks. */
  brandDescriptions: string[];
  hasAboutPage: boolean;
  hasContactPage: boolean;
  hasAuthorPages: boolean;
  organizationSchemaFound: boolean;
  websiteSchemaFound: boolean;
  /** Verified first-party facts the operator has entered. */
  verifiedFactCount: number;
  knownEntities: string[];
}

export interface GeoFinding {
  dimension: keyof typeof GEO_DIMENSION_WEIGHTS;
  severity: 'high' | 'medium' | 'low';
  message: string;
  url?: string;
}

/** Domains whose content is generally treated as primary/authoritative source material. */
const HIGH_QUALITY_SOURCE_PATTERNS = [
  /\.gov(\.[a-z]{2})?$/i, /\.edu(\.[a-z]{2})?$/i, /\.ac\.[a-z]{2}$/i,
  /(^|\.)who\.int$/i, /(^|\.)nih\.gov$/i, /(^|\.)nature\.com$/i, /(^|\.)science\.org$/i,
  /(^|\.)pubmed\.ncbi\.nlm\.nih\.gov$/i, /(^|\.)arxiv\.org$/i, /(^|\.)doi\.org$/i,
  /(^|\.)europa\.eu$/i, /(^|\.)oecd\.org$/i, /(^|\.)worldbank\.org$/i,
  /(^|\.)ieee\.org$/i, /(^|\.)acm\.org$/i, /(^|\.)jstor\.org$/i,
];

const DEFINITION_PATTERNS = [
  /\bis\s+(?:a|an|the)\s+/i,
  /\brefers?\s+to\b/i,
  /\bis\s+defined\s+as\b/i,
  /\bmeans\s+that\b/i,
  /\bstands\s+for\b/i,
  /\bes\s+(?:un|una|el|la)\s+/i,
];

const EXPERTISE_MARKERS = [
  'author', 'written by', 'reviewed by', 'medically reviewed', 'fact-checked', 'expert',
  'phd', 'md,', 'certified', 'years of experience', 'our research', 'our team', 'our study',
  'methodology', 'escrito por', 'revisado por',
];

const FIRST_PARTY_MARKERS = [
  'our data', 'our research', 'we analysed', 'we analyzed', 'we surveyed', 'we tested',
  'our study', 'our survey', 'in our experience', 'we measured', 'our benchmark',
  'internal data', 'we found that', 'our customers', 'nuestros datos', 'analizamos',
];

/**
 * Per-page GEO score from measurable criteria only.
 *
 * Deliberately deterministic: GEO is probabilistic in outcome, so the *inputs* at least must be
 * reproducible. Every dimension is a measurable property of the document, and the returned
 * explanation says what was measured. Recommendations are framed as best practices, never as
 * guaranteed ranking factors.
 */
export function scoreGeoPage(page: GeoPageInput, site: GeoSiteContext): ExplainableScore & { findings: GeoFinding[] } {
  const text = page.textContent ?? '';
  const sentences = splitSentences(text);
  const findings: GeoFinding[] = [];
  const factors: ScoreFactor[] = [];

  const add = (
    key: keyof typeof GEO_DIMENSION_WEIGHTS,
    value: number,
    explanation: string,
    finding?: { severity: GeoFinding['severity']; message: string },
  ) => {
    const weight = GEO_DIMENSION_WEIGHTS[key];
    factors.push({
      key,
      label: GEO_DIMENSION_LABELS[key],
      value: clamp(value),
      weight,
      contribution: round(clamp(value) * weight * 100, 2),
      explanation,
    });
    if (finding && value < 0.6) findings.push({ dimension: key, url: page.url, ...finding });
  };

  // ── Entity clarity: does the page name its subject explicitly and consistently? ──
  const subject = page.h1 ?? page.title ?? '';
  const subjectTokens = tokenize(subject).filter((t) => t.length > 3);
  const firstParagraph = sentences.slice(0, 3).join(' ');
  const subjectInOpening = subjectTokens.length
    ? subjectTokens.filter((t) => firstParagraph.toLowerCase().includes(t)).length / subjectTokens.length
    : 0;
  const brandMentioned = site.brandName ? containsPhrase(text, site.brandName) : false;
  const knownEntityHits = site.knownEntities.filter((e) => e && containsPhrase(text, e)).length;
  const entityClarity = clamp(
    subjectInOpening * 0.5 + (brandMentioned ? 0.25 : 0) + saturate(knownEntityHits, 3) * 0.25,
  );
  add(
    'entityClarity',
    entityClarity,
    `${Math.round(subjectInOpening * 100)}% of the page's subject terms appear in the opening lines; ` +
      `${brandMentioned ? 'the brand is named' : 'the brand is never named'}; ${knownEntityHits} known entities referenced.`,
    {
      severity: entityClarity < 0.3 ? 'high' : 'medium',
      message:
        'State what this page is about — and which product, company or person it concerns — in the first two sentences. ' +
        'Answer engines extract the subject from the opening, not from paragraph nine.',
    },
  );

  // ── Structured data ──
  const relevantSchemaForType: Record<string, string[]> = {
    ARTICLE: ['Article', 'BlogPosting', 'NewsArticle'],
    PRODUCT: ['Product', 'Offer', 'SoftwareApplication'],
    FAQ: ['FAQPage'],
    COMPARISON: ['ItemList', 'Product', 'Article'],
    ABOUT: ['Organization', 'AboutPage'],
    AUTHOR: ['Person', 'ProfilePage'],
    HOMEPAGE: ['Organization', 'WebSite'],
    LANDING: ['WebPage', 'Service', 'Product', 'SoftwareApplication'],
  };
  const expected = relevantSchemaForType[page.pageType] ?? [];
  const hasExpected = expected.length === 0 || expected.some((t) => page.schemaTypes.includes(t));
  const schemaScore = clamp(
    (page.schemaTypes.length > 0 ? 0.45 : 0) +
      (hasExpected && page.schemaTypes.length > 0 ? 0.35 : 0) +
      (page.schemaTypes.includes('BreadcrumbList') ? 0.1 : 0) +
      (page.schemaTypes.some((t) => ['Person', 'Organization'].includes(t)) ? 0.1 : 0),
  );
  add(
    'structuredData',
    schemaScore,
    page.schemaTypes.length
      ? `Schema present: ${page.schemaTypes.join(', ')}.${hasExpected ? '' : ` Expected one of ${expected.join('/')} for this page type.`}`
      : 'No structured data on this page.',
    {
      severity: page.schemaTypes.length === 0 ? 'high' : 'medium',
      message: expected.length
        ? `Add ${expected[0]} JSON-LD so machines can read this page's entity and its properties.`
        : 'Add JSON-LD describing this page and its main entity.',
    },
  );

  // ── Fact density: concrete, extractable claims per 100 words ──
  const numericFacts = (text.match(/\b\d[\d,.]*\s*(%|percent|million|billion|thousand|k\b|hours?|minutes?|days?|weeks?|months?|years?|users?|customers?|exercises?|[$€£]\d)/gi) ?? []).length;
  const standaloneNumbers = (text.match(/\b\d[\d,.]{1,}\b/g) ?? []).length;
  const factsPer100 = page.wordCount > 0 ? ((numericFacts * 2 + standaloneNumbers) / page.wordCount) * 100 : 0;
  const factDensity = clamp(saturate(factsPer100, 2.5));
  add(
    'factDensity',
    factDensity,
    `${numericFacts} quantified statement(s) and ${standaloneNumbers} numeric value(s) across ${page.wordCount} words ` +
      `(${factsPer100.toFixed(1)} per 100 words).`,
    {
      severity: 'medium',
      message:
        'Add specific, checkable numbers — quantities, durations, prices, measured results. Generative engines cite pages ' +
        'that give them concrete facts to quote, and skip pages of generic prose.',
    },
  );

  // ── Content structure: headings, lists, tables — the shapes that get extracted ──
  const headingCount = page.headings.length;
  const headingDensity = page.wordCount > 0 ? headingCount / (page.wordCount / 250) : 0;
  const html = page.html ?? '';
  const tableCount = (html.match(/<table[\s>]/gi) ?? []).length;
  const listCount = (html.match(/<[uo]l[\s>]/gi) ?? []).length;
  const questionHeadings = page.headings.filter((h) => /\?$/.test(h.text.trim()) || /^(what|how|why|when|where|who|which)\b/i.test(h.text.trim())).length;
  const structureScore = clamp(
    saturate(headingDensity, 1) * 0.4 +
      (listCount > 0 ? 0.2 : 0) +
      (tableCount > 0 ? 0.2 : 0) +
      saturate(questionHeadings, 2) * 0.2,
  );
  add(
    'contentStructure',
    structureScore,
    `${headingCount} headings (${headingDensity.toFixed(1)} per 250 words), ${listCount} list(s), ${tableCount} table(s), ` +
      `${questionHeadings} question-style heading(s).`,
    {
      severity: 'medium',
      message:
        'Break the page into question-shaped headings with short, self-contained answers, and use lists and tables for ' +
        'comparable data. Extractable blocks are what gets quoted.',
    },
  );

  // ── Expertise signals ──
  const lowerText = text.toLowerCase();
  const expertiseHits = EXPERTISE_MARKERS.filter((m) => lowerText.includes(m)).length;
  const hasAuthorSchema = page.schemaTypes.includes('Person') || hasAuthorInJsonLd(page.structuredData);
  const expertiseScore = clamp(
    saturate(expertiseHits, 2) * 0.45 + (hasAuthorSchema ? 0.35 : 0) + (site.hasAuthorPages ? 0.2 : 0),
  );
  add(
    'expertiseSignals',
    expertiseScore,
    `${expertiseHits} expertise marker(s) in the copy; author markup ${hasAuthorSchema ? 'present' : 'absent'}; ` +
      `site ${site.hasAuthorPages ? 'has' : 'has no'} author profile pages.`,
    {
      severity: 'medium',
      message:
        'Attribute the page to a named author with real credentials and link to a profile page, and mirror that in ' +
        'Person/author schema. Never invent an author — an unattributed page is better than a fabricated expert.',
    },
  );

  // ── Citation worthiness: would an assistant want to quote this? ──
  const uniqueSignals =
    (FIRST_PARTY_MARKERS.some((m) => lowerText.includes(m)) ? 1 : 0) +
    (tableCount > 0 ? 1 : 0) +
    (numericFacts >= 5 ? 1 : 0) +
    (page.wordCount >= 800 ? 1 : 0) +
    (questionHeadings >= 2 ? 1 : 0);
  const citationScore = clamp(uniqueSignals / 5);
  add(
    'citationWorthiness',
    citationScore,
    `${uniqueSignals}/5 citation signals present (original data, tables, quantified facts, depth, direct answers).`,
    {
      severity: 'medium',
      message:
        'Give the page something only it can offer: original measurements, a comparison table, a methodology note, or a ' +
        'clearly-labelled dataset. Restating what everyone else says earns no citations.',
    },
  );

  // ── Brand consistency ──
  let brandConsistency = 0.5;
  let brandExplanation = 'No brand name configured for this site, so consistency cannot be measured.';
  if (site.brandName) {
    const mentions = countOccurrences(lowerText, site.brandName.toLowerCase());
    const descriptionsAgree = site.brandDescriptions.length <= 1 ? 1 : brandDescriptionAgreement(site.brandDescriptions);
    brandConsistency = clamp((mentions > 0 ? 0.5 : 0) + descriptionsAgree * 0.5);
    brandExplanation = `Brand named ${mentions} time(s) on this page; site-wide brand descriptions agree ${Math.round(descriptionsAgree * 100)}%.`;
  }
  add('brandConsistency', brandConsistency, brandExplanation, {
    severity: 'low',
    message:
      'Describe the brand the same way everywhere — one canonical sentence for what it is and who it serves. ' +
      'Conflicting descriptions make an entity harder for an engine to resolve.',
  });

  // ── Definitions ──
  const definitionSentences = sentences.filter((s) => DEFINITION_PATTERNS.some((p) => p.test(s))).length;
  const earlyDefinition = sentences.slice(0, 4).some((s) => DEFINITION_PATTERNS.some((p) => p.test(s)));
  const definitionScore = clamp((earlyDefinition ? 0.6 : 0) + saturate(definitionSentences, 2) * 0.4);
  add(
    'definitions',
    definitionScore,
    `${definitionSentences} definitional sentence(s); ${earlyDefinition ? 'one appears in the opening' : 'none in the opening'}.`,
    {
      severity: 'medium',
      message:
        'Define the core term plainly near the top ("X is a …"). Definitions are the single most extractable sentence shape.',
    },
  );

  // ── Comparative content ──
  const comparativeMarkers = ['compared to', 'versus', ' vs ', 'unlike', 'in contrast', 'alternative to', 'difference between'];
  const comparativeHits = comparativeMarkers.filter((m) => lowerText.includes(m)).length;
  const comparativeScore = clamp((tableCount > 0 ? 0.5 : 0) + saturate(comparativeHits, 2) * 0.5);
  add(
    'comparativeContent',
    comparativeScore,
    `${comparativeHits} comparative phrase(s), ${tableCount} table(s).`,
    {
      severity: 'low',
      message:
        'Where the topic invites it, add an honest comparison table with the alternatives. Comparison content is ' +
        'disproportionately represented in AI answers.',
    },
  );

  // ── First-party data ──
  const firstPartyHits = FIRST_PARTY_MARKERS.filter((m) => lowerText.includes(m)).length;
  const firstPartyScore = clamp(saturate(firstPartyHits, 1.5) * 0.7 + (site.verifiedFactCount > 0 ? 0.3 : 0));
  add(
    'firstPartyData',
    firstPartyScore,
    `${firstPartyHits} first-party data marker(s); ${site.verifiedFactCount} verified brand fact(s) available site-wide.`,
    {
      severity: 'medium',
      message:
        'Publish something only you can know: usage statistics, benchmark results, survey findings — with the methodology. ' +
        'Original data is the most durable reason to be cited.',
    },
  );

  // ── Source quality ──
  const externalHosts = page.externalLinks
    .map((l) => safeHost(l.href))
    .filter((h): h is string => Boolean(h));
  const authoritative = externalHosts.filter((h) => HIGH_QUALITY_SOURCE_PATTERNS.some((p) => p.test(h))).length;
  const uniqueHosts = new Set(externalHosts).size;
  const sourceScore = clamp(saturate(authoritative, 1) * 0.6 + saturate(uniqueHosts, 3) * 0.4);
  add(
    'sourceQuality',
    sourceScore,
    `${uniqueHosts} distinct external source(s), ${authoritative} of them primary/authoritative domains.`,
    {
      severity: 'low',
      message:
        'Cite primary sources — the study, the standard, the official documentation — rather than secondary summaries. ' +
        'Never cite a source you have not verified exists.',
    },
  );

  const score = round(factors.reduce((t, f) => t + f.value * f.weight, 0) * 100, 1);
  const weakest = [...factors].sort((a, b) => a.value * a.weight - b.value * b.weight).slice(0, 2);

  return {
    score,
    factors: factors.sort((a, b) => b.weight - a.weight),
    findings,
    summary:
      score >= 75
        ? `Well structured for machine reading. Weakest dimension: ${weakest[0]?.label.toLowerCase() ?? 'none'}.`
        : `Biggest opportunities: ${weakest.map((f) => f.label.toLowerCase()).join(' and ')}. ` +
          'These are best-practice signals, not guaranteed ranking factors — AI retrieval is not deterministic.',
  };
}

export interface GeoSiteAuditResult {
  score: number;
  dimensions: Record<string, { score: number; weight: number; label: string; explanation: string }>;
  factors: ScoreFactor[];
  findings: GeoFinding[];
  pageScores: Array<{ pageId: string; url: string; score: number; factors: ScoreFactor[]; findings: GeoFinding[] }>;
  summary: string;
  pagesAudited: number;
}

/**
 * Site-level GEO score: the impression-weighted mean of page scores, plus site-wide checks
 * (Organization schema, About page, author pages, brand-description consistency) that no single
 * page can satisfy on its own.
 */
export function auditSiteGeo(
  pages: GeoPageInput[],
  site: GeoSiteContext,
  weights?: Map<string, number>,
): GeoSiteAuditResult {
  const auditable = pages.filter((p) => p.isIndexable && p.wordCount > 100);
  const pageScores = auditable.map((page) => {
    const result = scoreGeoPage(page, site);
    return { pageId: page.id, url: page.url, score: result.score, factors: result.factors, findings: result.findings };
  });

  const dimensionTotals = new Map<string, { weighted: number; weight: number }>();
  let totalWeight = 0;
  for (const pageScore of pageScores) {
    const w = Math.max(1, weights?.get(pageScore.pageId) ?? 1);
    totalWeight += w;
    for (const factor of pageScore.factors) {
      const entry = dimensionTotals.get(factor.key) ?? { weighted: 0, weight: 0 };
      entry.weighted += factor.value * w;
      entry.weight += w;
      dimensionTotals.set(factor.key, entry);
    }
  }

  const factors: ScoreFactor[] = [];
  const dimensions: GeoSiteAuditResult['dimensions'] = {};
  const findings: GeoFinding[] = [];

  for (const [key, weight] of Object.entries(GEO_DIMENSION_WEIGHTS)) {
    const totals = dimensionTotals.get(key);
    let value = totals && totals.weight > 0 ? totals.weighted / totals.weight : 0;
    let explanation = `Average across ${pageScores.length} audited page(s).`;

    // Site-wide overrides: some dimensions are properties of the site, not of a page.
    if (key === 'structuredData') {
      const siteBonus = (site.organizationSchemaFound ? 0.1 : -0.15) + (site.websiteSchemaFound ? 0.05 : 0);
      value = clamp(value + siteBonus);
      explanation += ` Organization schema ${site.organizationSchemaFound ? 'found' : 'missing'} site-wide.`;
      if (!site.organizationSchemaFound) {
        findings.push({
          dimension: 'structuredData',
          severity: 'high',
          message:
            'No Organization schema anywhere on the site. This is the anchor entity that ties the brand to a knowledge ' +
            'graph record — add it on the homepage with name, url, logo and sameAs profiles.',
        });
      }
    }
    if (key === 'entityClarity') {
      if (!site.hasAboutPage) {
        value = clamp(value - 0.12);
        explanation += ' No About page found.';
        findings.push({
          dimension: 'entityClarity',
          severity: 'high',
          message:
            'Publish a clear About page stating what the company is, what it makes, who it serves and who runs it. ' +
            'It is the page answer engines most often use to resolve a brand entity.',
        });
      }
      if (!site.hasContactPage) {
        value = clamp(value - 0.05);
        explanation += ' No Contact page found.';
      }
    }
    if (key === 'expertiseSignals' && !site.hasAuthorPages) {
      value = clamp(value - 0.1);
      explanation += ' No author profile pages found.';
      findings.push({
        dimension: 'expertiseSignals',
        severity: 'medium',
        message:
          'Add real author profile pages with credentials and link articles to them. Only use real people — fabricated ' +
          'author personas are both an integrity problem and a detectable one.',
      });
    }
    if (key === 'firstPartyData' && site.verifiedFactCount === 0) {
      explanation += ' No verified brand facts have been entered in the knowledge base.';
      findings.push({
        dimension: 'firstPartyData',
        severity: 'medium',
        message:
          'Record verified first-party facts in the site knowledge base so content agents can cite them instead of ' +
          'approximating. Unverified claims are held back for review rather than published.',
      });
    }

    factors.push({
      key,
      label: GEO_DIMENSION_LABELS[key as keyof typeof GEO_DIMENSION_WEIGHTS],
      value: clamp(value),
      weight,
      contribution: round(clamp(value) * weight * 100, 2),
      explanation,
    });
    dimensions[key] = {
      score: round(clamp(value) * 100, 1),
      weight,
      label: GEO_DIMENSION_LABELS[key as keyof typeof GEO_DIMENSION_WEIGHTS],
      explanation,
    };
  }

  // Roll up the most common page-level findings so the UI shows patterns, not 400 duplicates.
  const findingCounts = new Map<string, { finding: GeoFinding; count: number; urls: string[] }>();
  for (const pageScore of pageScores) {
    for (const finding of pageScore.findings) {
      const key = `${finding.dimension}|${finding.message.slice(0, 60)}`;
      const entry = findingCounts.get(key) ?? { finding, count: 0, urls: [] };
      entry.count++;
      if (entry.urls.length < 10) entry.urls.push(finding.url ?? '');
      findingCounts.set(key, entry);
    }
  }
  for (const { finding, count, urls } of [...findingCounts.values()].sort((a, b) => b.count - a.count).slice(0, 15)) {
    findings.push({
      dimension: finding.dimension,
      severity: count > pageScores.length * 0.5 ? 'high' : finding.severity,
      message: `${finding.message} (affects ${count} page${count === 1 ? '' : 's'}${urls[0] ? `, e.g. ${urls[0]}` : ''})`,
    });
  }

  const score = round(factors.reduce((t, f) => t + f.value * f.weight, 0) * 100, 1);
  const weakest = [...factors].sort((a, b) => a.value * a.weight - b.value * b.weight).slice(0, 3);

  return {
    score,
    dimensions,
    factors: factors.sort((a, b) => b.weight - a.weight),
    findings,
    pageScores,
    pagesAudited: pageScores.length,
    summary:
      pageScores.length === 0
        ? 'No pages with enough content to audit. Crawl the site first.'
        : `GEO readiness ${score}/100 across ${pageScores.length} pages. Weakest: ${weakest
            .map((f) => f.label.toLowerCase())
            .join(', ')}. These are best-practice signals for machine readability, not guaranteed ranking factors — ` +
          'treat improvements as raising the probability of being understood and cited, not as a deterministic lever.',
  };
}

function hasAuthorInJsonLd(blocks: unknown[]): boolean {
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if ('author' in record && record.author) return true;
    const graph = record['@graph'];
    if (Array.isArray(graph) && graph.some((n) => n && typeof n === 'object' && 'author' in (n as object))) return true;
  }
  return false;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/** How consistently the site describes its own brand — pairwise token overlap of descriptions. */
function brandDescriptionAgreement(descriptions: string[]): number {
  const sets = descriptions.slice(0, 10).map((d) => new Set(tokenize(d)));
  if (sets.length < 2) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const a = sets[i]!;
      const b = sets[j]!;
      let intersection = 0;
      for (const t of a) if (b.has(t)) intersection++;
      const union = a.size + b.size - intersection;
      total += union > 0 ? intersection / union : 0;
      pairs++;
    }
  }
  return pairs > 0 ? clamp(total / pairs) : 1;
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
