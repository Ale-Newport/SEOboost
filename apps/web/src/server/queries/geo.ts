import 'server-only';
import { prisma } from '@seo/db';
import {
  ForbiddenError,
  GEO_DIMENSION_LABELS,
  GEO_DIMENSION_WEIGHTS,
  NotFoundError,
  formatDateKey,
  round,
  type ExplainableScore,
  type ScoreFactor,
} from '@seo/shared';

/**
 * Read model for the GEO (generative engine optimisation) readiness screen.
 *
 * Everything returned here comes out of the stored `GeoAudit`/`GeoPageAudit` rows written by the
 * GEO agent — no dimension is re-derived in the UI layer, so the numbers on screen are always
 * the numbers the engine produced. When a site has never been audited the result says so and
 * names the prerequisite; nothing is estimated to fill the screen.
 */

export type GeoSeverity = 'high' | 'medium' | 'low';
export type GeoBadgeSeverity = 'HIGH' | 'MEDIUM' | 'LOW';
export type GeoEffort = 'LOW' | 'MEDIUM' | 'HIGH';
export type GeoImpact = 'LOW' | 'MEDIUM' | 'HIGH';

const SEVERITY_BADGE: Record<GeoSeverity, GeoBadgeSeverity> = {
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

const SEVERITY_RANK: Record<GeoSeverity, number> = { high: 0, medium: 1, low: 2 };

/** Every dimension the engine scores, in weight order — the UI renders all eleven, always. */
const DIMENSION_KEYS = Object.keys(GEO_DIMENSION_WEIGHTS) as Array<keyof typeof GEO_DIMENSION_WEIGHTS>;

const KNOWN_DIMENSIONS = new Set<string>(DIMENSION_KEYS);

/**
 * What each dimension actually measures, in the operator's language.
 *
 * The engine's own `explanation` says what was *found* on this site; this says what the
 * dimension *is*. Both are shown — the second is what makes the first legible.
 */
const DIMENSION_MEANING: Record<keyof typeof GEO_DIMENSION_WEIGHTS, string> = {
  entityClarity:
    'Whether the page names its subject — and the company, product or person it concerns — in the opening lines, where an answer engine looks for it.',
  structuredData:
    'JSON-LD describing the page and its main entity, matched against the schema types that fit this page type.',
  factDensity:
    'Concrete, quotable numbers per 100 words: quantities, durations, prices, measured results.',
  contentStructure:
    'Headings, lists and tables — the shapes a retrieval system can lift a self-contained answer out of.',
  expertiseSignals:
    'Named authors with real credentials, author markup, and profile pages that back them up.',
  citationWorthiness:
    'Whether the page offers something only it can: original data, a comparison table, a methodology note.',
  brandConsistency:
    'Whether the site describes its own brand the same way everywhere, so the entity resolves to one thing.',
  definitions:
    'Plain "X is a …" sentences near the top. The single most extractable sentence shape there is.',
  comparativeContent:
    'Honest comparisons against the alternatives, which are over-represented in AI answers.',
  firstPartyData:
    'Usage statistics, benchmarks and survey findings you published yourself, with the methodology attached.',
  sourceQuality:
    'Citations of primary sources — the study, the standard, the official documentation — rather than secondary summaries.',
};

export interface GeoDimensionPage {
  pageId: string;
  url: string;
  title: string | null;
  /** This dimension's raw 0-1 result on that page. */
  value: number;
}

export interface GeoFindingView {
  /** Stable react key; findings have no id of their own. */
  id: string;
  dimension: string;
  dimensionLabel: string;
  severity: GeoSeverity;
  badgeSeverity: GeoBadgeSeverity;
  message: string;
  url: string | null;
  /** Audited pages whose own findings flag this dimension. */
  affectedPages: number;
}

export interface GeoDimensionView {
  key: string;
  label: string;
  /** 0-1 share of the total score. */
  weight: number;
  /** 0-100. */
  score: number;
  /** What the engine measured on this site. */
  explanation: string;
  /** What the dimension means, independent of this site. */
  meaning: string;
  /** Points this dimension currently contributes to the overall score. */
  contribution: number;
  /** Points it is leaving on the table. */
  missed: number;
  pagesScored: number;
  pagesFlagged: number;
  weakestPages: GeoDimensionPage[];
  findings: GeoFindingView[];
}

export interface GeoRecommendationView {
  /** `${auditId}:${index}` — stable across a render, unique within an audit. */
  id: string;
  index: number;
  dimension: string;
  dimensionLabel: string;
  action: string;
  currentState: string;
  proposedChange: string;
  /** Why it matters, in the engine's words. */
  rationale: string;
  effort: GeoEffort;
  expectedImpact: GeoImpact;
  requiresHumanInput: boolean;
  humanInputNeeded: string | null;
  autoApplicable: boolean;
  targetUrl: string | null;
  /** Audited pages flagged on this recommendation's dimension. */
  affectedPages: number;
  /**
   * Deliberately capped at 0.6: GEO outcomes are not directly measurable, so the platform never
   * claims high confidence in an individual GEO change. Mirrors the GEO agent's own scale.
   */
  confidence: number;
  /** Set when this recommendation has already been turned into an action. */
  actionId: string | null;
  actionStatus: string | null;
}

export interface GeoPageRow {
  id: string;
  pageId: string;
  url: string;
  title: string | null;
  pageType: string;
  wordCount: number;
  score: number;
  /** Raw 0-1 value per dimension key. */
  dimensions: Record<string, number>;
  findingCount: number;
  worstDimension: { key: string; label: string; value: number } | null;
}

export interface GeoAuditSummary {
  id: string;
  overallScore: number;
  summary: string | null;
  method: string;
  pagesAudited: number;
  createdAt: Date;
  /** The score of the audit before this one, when there is one. */
  previousScore: number | null;
}

export interface GeoReadiness {
  website: {
    id: string;
    name: string;
    domain: string;
    protocol: string;
    geoScore: number | null;
  };
  audit: GeoAuditSummary | null;
  /** Null until the first audit; never a placeholder zero. */
  score: ExplainableScore | null;
  dimensions: GeoDimensionView[];
  findings: GeoFindingView[];
  recommendations: GeoRecommendationView[];
  pages: GeoPageRow[];
  /** Page audits stored for this audit, which may exceed the rows returned. */
  pageAuditCount: number;
  history: Array<{ date: string; score: number; pagesAudited: number }>;
  /** Prerequisites, so an empty screen can say exactly what to do next. */
  prerequisites: {
    crawledPages: number;
    indexablePages: number;
    /** Pages with enough content for the engine to score at all. */
    auditablePages: number;
    hasCompletedCrawl: boolean;
  };
}

/** Rows returned to the per-page table. The full set stays in the database. */
const PAGE_ROW_LIMIT = 500;

interface StoredDimension {
  score: number;
  weight: number;
  label: string;
  explanation: string;
}

interface StoredFinding {
  dimension: string;
  severity: GeoSeverity;
  message: string;
  url?: string | null;
}

interface StoredRecommendation {
  dimension: string;
  action: string;
  currentState: string;
  proposedChange: string;
  rationale: string;
  effort: string;
  expectedImpact: string;
  requiresHumanInput: boolean;
  humanInputNeeded: string | null;
  autoApplicable: boolean;
  targetUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function severityOf(value: unknown): GeoSeverity {
  return value === 'high' || value === 'medium' || value === 'low' ? value : 'medium';
}

function effortOf(value: unknown): GeoEffort {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' ? value : 'MEDIUM';
}

function impactOf(value: unknown): GeoImpact {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH' ? value : 'MEDIUM';
}

function labelFor(key: string): string {
  return GEO_DIMENSION_LABELS[key as keyof typeof GEO_DIMENSION_WEIGHTS] ?? key;
}

/** Json columns are `unknown` at the type level; narrow rather than cast. */
function parseDimensions(raw: unknown): Record<string, StoredDimension> {
  if (!isRecord(raw)) return {};
  const out: Record<string, StoredDimension> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    out[key] = {
      score: num(value.score, 0),
      weight: num(value.weight, GEO_DIMENSION_WEIGHTS[key as keyof typeof GEO_DIMENSION_WEIGHTS] ?? 0),
      label: str(value.label, labelFor(key)),
      explanation: str(value.explanation, ''),
    };
  }
  return out;
}

function parseFindings(raw: unknown): StoredFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredFinding[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const message = str(entry.message, '');
    if (!message) continue;
    out.push({
      dimension: str(entry.dimension, 'unknown'),
      severity: severityOf(entry.severity),
      message,
      url: typeof entry.url === 'string' && entry.url.length > 0 ? entry.url : null,
    });
  }
  return out;
}

function parseRecommendations(raw: unknown): StoredRecommendation[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredRecommendation[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const action = str(entry.action, '');
    if (!action) continue;
    out.push({
      dimension: str(entry.dimension, 'unknown'),
      action,
      currentState: str(entry.currentState, ''),
      proposedChange: str(entry.proposedChange, ''),
      rationale: str(entry.rationale, ''),
      effort: str(entry.effort, 'MEDIUM'),
      expectedImpact: str(entry.expectedImpact, 'MEDIUM'),
      requiresHumanInput: entry.requiresHumanInput === true,
      humanInputNeeded:
        typeof entry.humanInputNeeded === 'string' && entry.humanInputNeeded.length > 0
          ? entry.humanInputNeeded
          : null,
      autoApplicable: entry.autoApplicable === true,
      targetUrl: typeof entry.targetUrl === 'string' && entry.targetUrl.length > 0 ? entry.targetUrl : null,
    });
  }
  return out;
}

/** Per-page dimension blobs are `{ key: 0-1 }`, written by the GEO agent. */
function parsePageDimensions(raw: unknown): Record<string, number> {
  if (!isRecord(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Everything the GEO readiness screen renders, in one pass.
 *
 * Throws `NotFoundError`/`ForbiddenError` so the page can answer with `notFound()` rather than
 * leaking whether a website id exists on another account.
 */
export async function getGeoReadiness(userId: string, websiteId: string): Promise<GeoReadiness> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    select: { id: true, userId: true, name: true, domain: true, protocol: true, geoScore: true },
  });
  if (!website) throw new NotFoundError('Website');
  if (website.userId !== userId) throw new ForbiddenError('You do not have access to this website.');

  const [audit, history, crawledPages, indexablePages, auditablePages, latestCrawl] = await Promise.all([
    prisma.geoAudit.findFirst({
      where: { websiteId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        overallScore: true,
        dimensions: true,
        findings: true,
        recommendations: true,
        pagesAudited: true,
        method: true,
        summary: true,
        createdAt: true,
      },
    }),
    prisma.geoAudit.findMany({
      where: { websiteId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { overallScore: true, pagesAudited: true, createdAt: true },
    }),
    prisma.page.count({ where: { websiteId, isActive: true } }),
    prisma.page.count({ where: { websiteId, isActive: true, isIndexable: true } }),
    prisma.page.count({ where: { websiteId, isActive: true, isIndexable: true, wordCount: { gt: 100 } } }),
    prisma.crawl.findFirst({
      where: { websiteId, status: 'COMPLETED' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
  ]);

  const prerequisites = {
    crawledPages,
    indexablePages,
    auditablePages,
    hasCompletedCrawl: latestCrawl !== null,
  };

  const base = {
    website: {
      id: website.id,
      name: website.name,
      domain: website.domain,
      protocol: website.protocol,
      geoScore: website.geoScore,
    },
    history: history
      .map((row) => ({
        date: formatDateKey(row.createdAt),
        score: round(row.overallScore, 1),
        pagesAudited: row.pagesAudited,
      }))
      .reverse(),
    prerequisites,
  };

  if (!audit) {
    return {
      ...base,
      audit: null,
      score: null,
      dimensions: [],
      findings: [],
      recommendations: [],
      pages: [],
      pageAuditCount: 0,
    };
  }

  const [pageAudits, pageAuditCount, geoActions] = await Promise.all([
    prisma.geoPageAudit.findMany({
      where: { auditId: audit.id },
      orderBy: { score: 'asc' },
      take: PAGE_ROW_LIMIT,
      select: {
        id: true,
        score: true,
        dimensions: true,
        findings: true,
        page: { select: { id: true, url: true, title: true, pageType: true, wordCount: true } },
      },
    }),
    prisma.geoPageAudit.count({ where: { auditId: audit.id } }),
    // Recommendations the agent (or this screen) already turned into actions, so the UI offers
    // "view action" instead of creating a duplicate.
    prisma.seoAction.findMany({
      where: { websiteId, sourceType: 'GeoAudit', sourceId: { startsWith: `${audit.id}:` } },
      select: { id: true, sourceId: true, status: true },
    }),
  ]);

  const storedDimensions = parseDimensions(audit.dimensions);
  const storedFindings = parseFindings(audit.findings);
  const storedRecommendations = parseRecommendations(audit.recommendations);

  // How many audited pages flagged each dimension, counted from the page audits themselves
  // rather than parsed out of the rolled-up finding text.
  const flaggedByDimension = new Map<string, number>();
  const pageValuesByDimension = new Map<string, GeoDimensionPage[]>();

  const pages: GeoPageRow[] = pageAudits.map((row) => {
    const dimensions = parsePageDimensions(row.dimensions);
    const findings = parseFindings(row.findings);
    const flagged = new Set(findings.map((finding) => finding.dimension));
    for (const dimension of flagged) {
      flaggedByDimension.set(dimension, (flaggedByDimension.get(dimension) ?? 0) + 1);
    }
    for (const [key, value] of Object.entries(dimensions)) {
      const bucket = pageValuesByDimension.get(key) ?? [];
      bucket.push({ pageId: row.page.id, url: row.page.url, title: row.page.title, value });
      pageValuesByDimension.set(key, bucket);
    }

    // Only dimensions the current engine still weighs; a key left over from an older audit
    // must not be reported as this page's biggest problem.
    let worst: GeoPageRow['worstDimension'] = null;
    for (const [key, value] of Object.entries(dimensions)) {
      if (!KNOWN_DIMENSIONS.has(key)) continue;
      if (worst === null || value < worst.value) worst = { key, label: labelFor(key), value };
    }

    return {
      id: row.id,
      pageId: row.page.id,
      url: row.page.url,
      title: row.page.title,
      pageType: row.page.pageType,
      wordCount: row.page.wordCount,
      score: round(row.score, 1),
      dimensions,
      findingCount: findings.length,
      worstDimension: worst,
    };
  });

  const findings: GeoFindingView[] = storedFindings
    .map((finding, index) => ({
      id: `${audit.id}:finding:${index}`,
      dimension: finding.dimension,
      dimensionLabel: labelFor(finding.dimension),
      severity: finding.severity,
      badgeSeverity: SEVERITY_BADGE[finding.severity],
      message: finding.message,
      url: finding.url ?? null,
      affectedPages: flaggedByDimension.get(finding.dimension) ?? 0,
    }))
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.affectedPages - a.affectedPages);

  const findingsByDimension = new Map<string, GeoFindingView[]>();
  for (const finding of findings) {
    const bucket = findingsByDimension.get(finding.dimension) ?? [];
    bucket.push(finding);
    findingsByDimension.set(finding.dimension, bucket);
  }

  const dimensions: GeoDimensionView[] = DIMENSION_KEYS.map((key) => {
    const stored = storedDimensions[key];
    const weight = GEO_DIMENSION_WEIGHTS[key];
    const score = stored ? round(stored.score, 1) : 0;
    const pageValues = (pageValuesByDimension.get(key) ?? []).slice().sort((a, b) => a.value - b.value);

    return {
      key,
      label: GEO_DIMENSION_LABELS[key],
      weight,
      score,
      explanation: stored?.explanation ?? 'This dimension was not recorded in the stored audit.',
      meaning: DIMENSION_MEANING[key],
      contribution: round((score / 100) * weight * 100, 1),
      missed: round(weight * 100 - (score / 100) * weight * 100, 1),
      pagesScored: pageValues.length,
      pagesFlagged: flaggedByDimension.get(key) ?? 0,
      weakestPages: pageValues.slice(0, 10),
      findings: findingsByDimension.get(key) ?? [],
    };
  }).sort((a, b) => b.weight - a.weight);

  const factors: ScoreFactor[] = dimensions.map((dimension) => ({
    key: dimension.key,
    label: dimension.label,
    value: dimension.score / 100,
    weight: dimension.weight,
    contribution: dimension.contribution,
    explanation: dimension.explanation,
  }));

  const actionBySourceId = new Map(geoActions.map((action) => [action.sourceId ?? '', action]));

  const recommendations: GeoRecommendationView[] = storedRecommendations.map((entry, index) => {
    const existing = actionBySourceId.get(`${audit.id}:${entry.dimension}`) ?? null;
    return {
      id: `${audit.id}:${index}`,
      index,
      dimension: entry.dimension,
      dimensionLabel: labelFor(entry.dimension),
      action: entry.action,
      currentState: entry.currentState,
      proposedChange: entry.proposedChange,
      rationale: entry.rationale,
      effort: effortOf(entry.effort),
      expectedImpact: impactOf(entry.expectedImpact),
      requiresHumanInput: entry.requiresHumanInput,
      humanInputNeeded: entry.humanInputNeeded,
      autoApplicable: entry.autoApplicable,
      targetUrl: entry.targetUrl,
      affectedPages: flaggedByDimension.get(entry.dimension) ?? 0,
      confidence: entry.requiresHumanInput ? 0.45 : 0.6,
      actionId: existing?.id ?? null,
      actionStatus: existing?.status ?? null,
    };
  });

  const previous = history[1];

  return {
    ...base,
    audit: {
      id: audit.id,
      overallScore: round(audit.overallScore, 1),
      summary: audit.summary,
      method: audit.method,
      pagesAudited: audit.pagesAudited,
      createdAt: audit.createdAt,
      previousScore: previous ? round(previous.overallScore, 1) : null,
    },
    score: {
      score: round(audit.overallScore, 1),
      factors,
      summary:
        audit.summary ??
        `GEO readiness ${round(audit.overallScore, 1)}/100 across ${audit.pagesAudited} audited page(s).`,
    },
    dimensions,
    findings,
    recommendations,
    pages,
    pageAuditCount,
  };
}
