import { z } from 'zod';
import { ActionStatus, ActionType, json, prisma, readJson } from '@seo/db';
import { ConflictError, NotFoundError, ValidationError, createLogger, round, truncate } from '@seo/shared';
import { calculatePriority, riskBandForActionType, riskLevelForActionType } from '@seo/seo-engine';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly, requireScopedWebsite } from '@/app/api/_lib/common';

const log = createLogger('api:geo:actions');

/**
 * `POST /api/geo/actions` — turn one stored GEO recommendation into a tracked `SeoAction`.
 *
 * The GEO agent proposes actions for the recommendations it ranks highest; this is the manual
 * path for the rest, so an operator can promote a recommendation the agent skipped without
 * re-running the whole audit.
 *
 * Nothing is invented here: the title, reasoning and evidence all come from the stored audit
 * row, and the action is created as `PROPOSED` — it goes through the same approval and
 * execution flow as any other. Confidence is capped the way the GEO agent caps it, because GEO
 * outcomes are not directly measurable.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  auditId: z.string().trim().min(1),
  /** Position in the audit's stored `recommendations` array. */
  index: z.coerce.number().int().min(0).max(999),
});

const EFFORT_SCALE: Record<string, number> = { LOW: 1, MEDIUM: 3, HIGH: 5 };
const IMPACT_SCALE: Record<string, number> = { HIGH: 0.7, MEDIUM: 0.45, LOW: 0.25 };

/**
 * The honesty clause carried on every GEO action.
 *
 * Nobody outside the model vendors knows how answer engines choose sources. These changes make
 * a page easier to retrieve, extract and attribute — they raise the likelihood of citation,
 * they do not guarantee it.
 */
const GEO_DISCLAIMER =
  'GEO guidance is probabilistic best practice, not a set of confirmed ranking factors. Answer engines do not ' +
  'publish how they select and cite sources. These changes make a page easier to retrieve, extract and attribute, ' +
  'which raises the likelihood of citation — they do not guarantee it.';

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

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseRecommendation(raw: unknown): StoredRecommendation | null {
  if (!isRecord(raw)) return null;
  const action = text(raw.action);
  if (!action) return null;
  return {
    dimension: text(raw.dimension) || 'unknown',
    action,
    currentState: text(raw.currentState),
    proposedChange: text(raw.proposedChange),
    rationale: text(raw.rationale),
    effort: text(raw.effort) || 'MEDIUM',
    expectedImpact: text(raw.expectedImpact) || 'MEDIUM',
    requiresHumanInput: raw.requiresHumanInput === true,
    humanInputNeeded: text(raw.humanInputNeeded) || null,
    autoApplicable: raw.autoApplicable === true,
    targetUrl: text(raw.targetUrl) || null,
  };
}

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const website = await requireScopedWebsite(user, body.websiteId);

  const audit = await prisma.geoAudit.findFirst({
    where: { id: body.auditId, websiteId: website.id },
    select: { id: true, overallScore: true, pagesAudited: true, recommendations: true },
  });
  if (!audit) throw new NotFoundError('GEO audit');

  const stored = readJson<unknown[]>(audit.recommendations, []);
  const recommendation = parseRecommendation(stored[body.index]);
  if (!recommendation) {
    throw new ValidationError('That recommendation is no longer part of the stored audit. Reload the page.');
  }

  // Same key the GEO agent uses, so promoting a recommendation twice — from here or from a
  // re-run of the agent — can never produce two competing actions for one dimension.
  const sourceId = `${audit.id}:${recommendation.dimension}`;
  const existing = await prisma.seoAction.findFirst({
    where: { websiteId: website.id, sourceType: 'GeoAudit', sourceId },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError('This recommendation is already tracked as an action.');
  }

  const impact = IMPACT_SCALE[recommendation.expectedImpact] ?? 0.35;
  const effort = EFFORT_SCALE[recommendation.effort] ?? 3;
  const confidence = recommendation.requiresHumanInput ? 0.45 : 0.6;
  const risk = riskLevelForActionType(ActionType.GEO_IMPROVEMENT);
  const priority = calculatePriority({
    impact,
    confidence,
    businessValue: 0.5,
    effort,
    risk,
  });

  const reasoning =
    `${recommendation.currentState} ${recommendation.proposedChange} ` +
    `Why it matters: ${recommendation.rationale} ` +
    (recommendation.requiresHumanInput && recommendation.humanInputNeeded
      ? `This needs input from the business: ${recommendation.humanInputNeeded}. `
      : '') +
    GEO_DISCLAIMER;

  const action = await prisma.seoAction.create({
    data: {
      websiteId: website.id,
      type: ActionType.GEO_IMPROVEMENT,
      title: truncate(recommendation.action, 120, '…'),
      status: ActionStatus.PROPOSED,
      risk: riskBandForActionType(ActionType.GEO_IMPROVEMENT),
      reasoning: reasoning.replace(/\s+/g, ' ').trim(),
      evidence: json({
        dimension: recommendation.dimension,
        siteGeoScore: round(audit.overallScore, 1),
        auditId: audit.id,
        pagesAudited: audit.pagesAudited,
        expectedImpact: recommendation.expectedImpact,
        effort: recommendation.effort,
        requiresHumanInput: recommendation.requiresHumanInput,
        promotedBy: user.id,
        disclaimer: GEO_DISCLAIMER,
      }),
      affectedUrls: recommendation.targetUrl ? [recommendation.targetUrl] : [],
      payload: json({
        dimension: recommendation.dimension,
        proposedChange: recommendation.proposedChange,
        auditId: audit.id,
      }),
      impactScore: impact,
      effortScore: effort,
      confidenceScore: confidence,
      riskScore: risk,
      priorityScore: priority.score,
      priorityFactors: json(priority),
      sourceType: 'GeoAudit',
      sourceId,
      // A GEO change is a content edit; it never executes itself off the back of this promotion.
      autoExecutable: false,
    },
    select: { id: true, title: true, status: true, priorityScore: true },
  });

  log.info('geo recommendation promoted to action', {
    websiteId: website.id,
    auditId: audit.id,
    dimension: recommendation.dimension,
    actionId: action.id,
  });

  return { action, disclaimer: GEO_DISCLAIMER };
});
