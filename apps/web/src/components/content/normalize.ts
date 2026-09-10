import type { ExplainableScore, ScoreFactor } from '@seo/shared';

import type {
  ClaimSeverity,
  ContentStageStatusValue,
  ContentStageValue,
  DraftSource,
  InternalLinkSuggestionItem,
  KeywordCoverage,
  OpportunityCandidate,
  OpportunityEvidence,
  OpportunityStatusValue,
  OpportunityTypeValue,
  QualityFlagItem,
  UnverifiedClaim,
} from './types';
import { CONTENT_STAGES, CONTENT_STAGE_STATUSES, OPPORTUNITY_STATUSES, OPPORTUNITY_TYPES } from './types';

/**
 * Narrowing for the JSON columns the content agents write.
 *
 * These run on the server, once per request, so the client components receive real types instead
 * of `unknown`. Every reader is deliberately lossy in one direction only: a field that is missing
 * or the wrong shape becomes `null` and renders as "not measured". Nothing here substitutes a
 * default that would read as a measurement — a zero impression count and an unknown impression
 * count are different facts.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Non-empty strings only: `""` from a model is an absent value, not a label. */
function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function strList(value: unknown): string[] {
  return asArray(value).flatMap((entry) => {
    const text = str(entry);
    return text === null ? [] : [text];
  });
}

/** Accepts a `Date`, an ISO string, or an epoch number; anything else is "no date". */
export function isoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

// ── enum guards ──────────────────────────────────────────────

export function toStage(value: string): ContentStageValue {
  return (CONTENT_STAGES as readonly string[]).includes(value) ? (value as ContentStageValue) : 'RESEARCH';
}

export function toStageStatus(value: string): ContentStageStatusValue {
  return (CONTENT_STAGE_STATUSES as readonly string[]).includes(value)
    ? (value as ContentStageStatusValue)
    : 'PENDING';
}

export function toOpportunityType(value: string): OpportunityTypeValue {
  return (OPPORTUNITY_TYPES as readonly string[]).includes(value) ? (value as OpportunityTypeValue) : 'NO_ACTION';
}

export function toOpportunityStatus(value: string): OpportunityStatusValue {
  return (OPPORTUNITY_STATUSES as readonly string[]).includes(value)
    ? (value as OpportunityStatusValue)
    : 'IDENTIFIED';
}

// ── explainable scores ───────────────────────────────────────

function toScoreFactor(value: unknown): ScoreFactor | null {
  if (!isRecord(value)) return null;
  const label = str(value.label);
  const weight = num(value.weight);
  const contribution = num(value.contribution);
  const raw = num(value.value);
  // A factor missing any of its numbers cannot be drawn honestly, so it is dropped rather than
  // rendered as an empty bar that looks like a measured zero.
  if (label === null || weight === null || contribution === null || raw === null) return null;
  return {
    key: str(value.key) ?? label,
    label,
    value: raw,
    weight,
    contribution,
    explanation: str(value.explanation) ?? '',
  };
}

export function toScoreFactors(value: unknown): ScoreFactor[] {
  return asArray(value).flatMap((entry) => {
    const factor = toScoreFactor(entry);
    return factor === null ? [] : [factor];
  });
}

/** `null` when no factors survived — the UI must then say the score is unexplained, not fake one. */
export function toExplainableScore(
  score: number | null,
  factors: ScoreFactor[],
  summary: string | null,
): ExplainableScore | null {
  if (score === null || factors.length === 0) return null;
  return { score, factors, summary: summary ?? '' };
}

// ── opportunities ────────────────────────────────────────────

function toCandidate(value: unknown): OpportunityCandidate | null {
  if (!isRecord(value)) return null;
  const url = str(value.url);
  if (url === null) return null;
  return {
    url,
    title: str(value.title),
    similarity: num(value.similarity),
    reason: str(value.reason),
  };
}

export function toOpportunityEvidence(value: unknown): OpportunityEvidence {
  const record = isRecord(value) ? value : {};
  const bestMatch = isRecord(record.bestMatch) ? record.bestMatch : null;
  return {
    impressions: num(record.impressions),
    clicks: num(record.clicks),
    currentPosition: num(record.currentPosition),
    pagesEvaluated: num(record.pagesEvaluated),
    bestMatchUrl: bestMatch ? str(bestMatch.url) : null,
    bestMatchSimilarity: bestMatch ? num(bestMatch.similarity) : null,
    cannibalizingUrls: strList(record.cannibalizingUrls),
    candidates: asArray(record.candidates).flatMap((entry) => {
      const candidate = toCandidate(entry);
      return candidate === null ? [] : [candidate];
    }),
    deterministicDecision: str(record.deterministicDecision),
    modelDecision: str(record.modelDecision),
    rejectionReason: str(record.rejectionReason),
    rejectedAt: isoDate(record.rejectedAt),
    acceptanceNote: str(record.acceptanceNote),
  };
}

/** The priority score's own factors, recorded by the discovery pass alongside the evidence. */
export function toPriorityScore(priorityScore: number, evidence: unknown): ExplainableScore | null {
  const record = isRecord(evidence) ? evidence : {};
  return toExplainableScore(
    priorityScore,
    toScoreFactors(record.priorityFactors),
    str(record.priorityExplanation),
  );
}

// ── draft JSON columns ───────────────────────────────────────

const CLAIM_SEVERITIES: readonly ClaimSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

function toClaimSeverity(value: unknown): ClaimSeverity {
  const text = str(value)?.toUpperCase();
  // An unrecognised severity is treated as HIGH: an unverifiable claim with an unknown weight is
  // the last thing that should be quietly demoted.
  return text !== undefined && (CLAIM_SEVERITIES as readonly string[]).includes(text)
    ? (text as ClaimSeverity)
    : 'HIGH';
}

export function toUnverifiedClaims(value: unknown): UnverifiedClaim[] {
  return asArray(value).flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const quote = str(entry.quote);
    if (quote === null) return [];
    return [
      {
        id: `claim-${index}`,
        quote,
        classification: str(entry.classification) ?? 'UNSUPPORTED',
        severity: toClaimSeverity(entry.severity),
        why: str(entry.why),
        suggestedFix: str(entry.suggestedFix),
        source: str(entry.source),
      },
    ];
  });
}

export function toQualityFlags(value: unknown): QualityFlagItem[] {
  return asArray(value).flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const message = str(entry.message);
    if (message === null) return [];
    const severity = str(entry.severity)?.toUpperCase();
    return [
      {
        id: `flag-${index}`,
        code: str(entry.code) ?? 'QUALITY',
        severity: severity === 'BLOCKING' ? 'BLOCKING' : severity === 'INFO' ? 'INFO' : 'WARNING',
        message,
      },
    ];
  });
}

export function toSources(value: unknown): DraftSource[] {
  return asArray(value).flatMap((entry, index) => {
    if (typeof entry === 'string') {
      const url = str(entry);
      return url === null
        ? []
        : [{ id: `source-${index}`, url, title: null, publisher: null, retrievedAt: null }];
    }
    if (!isRecord(entry)) return [];
    const url = str(entry.url);
    const title = str(entry.title);
    if (url === null && title === null) return [];
    return [
      {
        id: `source-${index}`,
        url,
        title,
        publisher: str(entry.publisher) ?? str(entry.site) ?? str(entry.domain),
        retrievedAt: isoDate(entry.retrievedAt ?? entry.retrievedOn ?? entry.accessedAt),
      },
    ];
  });
}

/** Anchor text already wrapped in a markdown link pointing at `url`. */
function isAlreadyLinked(body: string, anchor: string, url: string): boolean {
  return body.includes(`[${anchor}](${url})`);
}

export function toInternalLinks(value: unknown, bodyMarkdown: string): InternalLinkSuggestionItem[] {
  return asArray(value).flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const targetUrl = str(entry.targetUrl) ?? str(entry.url);
    const anchorText = str(entry.anchorText) ?? str(entry.anchor);
    if (targetUrl === null || anchorText === null) return [];
    const alreadyLinked = isAlreadyLinked(bodyMarkdown, anchorText, targetUrl);
    return [
      {
        id: `link-${index}`,
        targetUrl,
        anchorText,
        reason: str(entry.reason),
        anchorPresent: bodyMarkdown.includes(anchorText),
        alreadyLinked,
      },
    ];
  });
}

export function toKeywordCoverage(value: unknown): KeywordCoverage | null {
  if (!isRecord(value)) return null;
  const coverage: KeywordCoverage = {
    density: num(value.density),
    inFirstParagraph: bool(value.inFirstParagraph),
    inHeading: bool(value.inHeading),
    headingCount: num(value.headingCount),
    secondaryPresent: strList(value.secondaryPresent),
  };
  const measured =
    coverage.density !== null ||
    coverage.inFirstParagraph !== null ||
    coverage.inHeading !== null ||
    coverage.headingCount !== null ||
    coverage.secondaryPresent.length > 0;
  return measured ? coverage : null;
}

/** Brief outlines are stored as `[{heading}]`, `[{text}]` or plain strings depending on the stage. */
export function toOutline(value: unknown): string[] {
  return asArray(value).flatMap((entry) => {
    if (typeof entry === 'string') {
      const text = str(entry);
      return text === null ? [] : [text];
    }
    if (!isRecord(entry)) return [];
    const heading = str(entry.heading) ?? str(entry.title) ?? str(entry.text);
    if (heading === null) return [];
    const level = num(entry.level);
    return [level !== null && level > 2 ? `${' '.repeat(level - 2)}${heading}` : heading];
  });
}
