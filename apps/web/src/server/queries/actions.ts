import 'server-only';
import {
  ActionRisk,
  ActionStatus,
  ActionType,
  ApprovalStatus,
  type Prisma,
  buildPaginated,
  paginate,
  prisma,
  readJson,
} from '@seo/db';
import {
  DEFAULT_PAGE_SIZE,
  ForbiddenError,
  MAX_PAGE_SIZE,
  NotFoundError,
  type ExplainableScore,
  type Paginated,
  clamp,
} from '@seo/shared';
import { canAutoExecute, riskBandForActionType } from '@seo/seo-engine';

/**
 * Read model for the prioritised action queue.
 *
 * Server components and the `/api/actions` routes both call in here so the list a user sees and
 * the list the API paginates can never drift apart. Nothing in this module writes.
 */

const ACTION_SELECT = {
  id: true,
  websiteId: true,
  type: true,
  title: true,
  status: true,
  risk: true,
  reasoning: true,
  evidence: true,
  affectedUrls: true,
  requiredAgent: true,
  impactScore: true,
  effortScore: true,
  confidenceScore: true,
  businessValue: true,
  riskScore: true,
  priorityScore: true,
  priorityFactors: true,
  sourceType: true,
  sourceId: true,
  autoExecutable: true,
  proposedAt: true,
  approvedAt: true,
  executedAt: true,
  completedAt: true,
  measureAfter: true,
  error: true,
  updatedAt: true,
  website: { select: { id: true, name: true, domain: true } },
  approvals: {
    where: { status: ApprovalStatus.PENDING },
    select: { id: true, risk: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 1,
  },
  _count: { select: { executions: true } },
} satisfies Prisma.SeoActionSelect;

type ActionRow = Prisma.SeoActionGetPayload<{ select: typeof ACTION_SELECT }>;

export interface ActionListItem {
  id: string;
  websiteId: string;
  website: { id: string; name: string; domain: string };
  type: ActionType;
  title: string;
  status: ActionStatus;
  risk: ActionRisk;
  reasoning: string;
  affectedUrls: string[];
  requiredAgent: string | null;
  priorityScore: number;
  /** The factors behind `priorityScore`, so the queue is explainable rather than a bare number. */
  priorityFactors: ExplainableScore | Record<string, unknown>;
  impactScore: number;
  effortScore: number;
  confidenceScore: number;
  businessValue: number;
  riskScore: number;
  autoExecutable: boolean;
  sourceType: string | null;
  sourceId: string | null;
  proposedAt: Date;
  approvedAt: Date | null;
  executedAt: Date | null;
  completedAt: Date | null;
  measureAfter: Date | null;
  error: string | null;
  updatedAt: Date;
  executionCount: number;
  /** The approval this action is waiting on, when one is open. */
  pendingApprovalId: string | null;
}

function toListItem(row: ActionRow): ActionListItem {
  return {
    id: row.id,
    websiteId: row.websiteId,
    website: row.website,
    type: row.type,
    title: row.title,
    status: row.status,
    risk: row.risk,
    reasoning: row.reasoning,
    affectedUrls: row.affectedUrls,
    requiredAgent: row.requiredAgent,
    priorityScore: row.priorityScore,
    priorityFactors: readJson<Record<string, unknown>>(row.priorityFactors, {}),
    impactScore: row.impactScore,
    effortScore: row.effortScore,
    confidenceScore: row.confidenceScore,
    businessValue: row.businessValue,
    riskScore: row.riskScore,
    autoExecutable: row.autoExecutable,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    proposedAt: row.proposedAt,
    approvedAt: row.approvedAt,
    executedAt: row.executedAt,
    completedAt: row.completedAt,
    measureAfter: row.measureAfter,
    error: row.error,
    updatedAt: row.updatedAt,
    executionCount: row._count.executions,
    pendingApprovalId: row.approvals[0]?.id ?? null,
  };
}

export type ActionSort = 'priorityScore' | 'proposedAt' | 'updatedAt' | 'impactScore';

export interface ActionListFilters {
  /** Websites the caller is allowed to read. An empty array yields an empty page. */
  websiteIds: string[];
  status?: ActionStatus[];
  type?: ActionType[];
  risk?: ActionRisk[];
  /** Only actions scoring at or above this 0-100 priority. */
  minPriority?: number;
  search?: string;
  page?: number;
  pageSize?: number;
  sort?: ActionSort;
  order?: 'asc' | 'desc';
}

function buildWhere(filters: ActionListFilters): Prisma.SeoActionWhereInput {
  const search = filters.search?.trim();
  return {
    websiteId: { in: filters.websiteIds },
    ...(filters.status?.length ? { status: { in: filters.status } } : {}),
    ...(filters.type?.length ? { type: { in: filters.type } } : {}),
    ...(filters.risk?.length ? { risk: { in: filters.risk } } : {}),
    ...(typeof filters.minPriority === 'number' ? { priorityScore: { gte: filters.minPriority } } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { reasoning: { contains: search, mode: 'insensitive' } },
            { affectedUrls: { has: search } },
          ],
        }
      : {}),
  };
}

/** One page of the action queue, highest priority first by default. */
export async function listActions(filters: ActionListFilters): Promise<Paginated<ActionListItem>> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.floor(clamp(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE));

  if (filters.websiteIds.length === 0) return buildPaginated<ActionListItem>([], 0, page, pageSize);

  const where = buildWhere(filters);
  const sort: ActionSort = filters.sort ?? 'priorityScore';
  const order: Prisma.SortOrder = filters.order ?? 'desc';

  const primary: Prisma.SeoActionOrderByWithRelationInput =
    sort === 'proposedAt'
      ? { proposedAt: order }
      : sort === 'updatedAt'
        ? { updatedAt: order }
        : sort === 'impactScore'
          ? { impactScore: order }
          : { priorityScore: order };

  const [rows, total] = await Promise.all([
    prisma.seoAction.findMany({
      where,
      select: ACTION_SELECT,
      // A stable secondary key keeps pagination deterministic when scores tie.
      orderBy: [primary, { proposedAt: 'desc' }],
      ...paginate(page, pageSize),
    }),
    prisma.seoAction.count({ where }),
  ]);

  return buildPaginated(rows.map(toListItem), total, page, pageSize);
}

export interface ActionQueueSummary {
  total: number;
  byStatus: Record<string, number>;
  byRisk: Record<string, number>;
  byType: Record<string, number>;
  awaitingApproval: number;
  readyToExecute: number;
}

/** Counts for the queue header. Three `groupBy` round-trips, no per-row work. */
export async function getActionSummary(websiteIds: string[]): Promise<ActionQueueSummary> {
  const empty: ActionQueueSummary = {
    total: 0,
    byStatus: {},
    byRisk: {},
    byType: {},
    awaitingApproval: 0,
    readyToExecute: 0,
  };
  if (websiteIds.length === 0) return empty;

  const where: Prisma.SeoActionWhereInput = { websiteId: { in: websiteIds } };
  const [byStatus, byRisk, byType] = await Promise.all([
    prisma.seoAction.groupBy({ by: ['status'], where, _count: { _all: true } }),
    prisma.seoAction.groupBy({ by: ['risk'], where, _count: { _all: true } }),
    prisma.seoAction.groupBy({ by: ['type'], where, _count: { _all: true } }),
  ]);

  const summary: ActionQueueSummary = { ...empty, byStatus: {}, byRisk: {}, byType: {} };
  for (const row of byStatus) {
    summary.byStatus[row.status] = row._count._all;
    summary.total += row._count._all;
  }
  for (const row of byRisk) summary.byRisk[row.risk] = row._count._all;
  for (const row of byType) summary.byType[row.type] = row._count._all;

  summary.awaitingApproval = summary.byStatus[ActionStatus.AWAITING_APPROVAL] ?? 0;
  summary.readyToExecute =
    (summary.byStatus[ActionStatus.APPROVED] ?? 0) + (summary.byStatus[ActionStatus.PROPOSED] ?? 0);
  return summary;
}

const DETAIL_INCLUDE = {
  website: { select: { id: true, name: true, domain: true, userId: true, settings: true } },
  executions: { orderBy: { startedAt: 'desc' }, take: 10 },
  approvals: { orderBy: { createdAt: 'desc' }, take: 10 },
  experiment: true,
  changeLogs: { orderBy: { createdAt: 'desc' }, take: 20 },
} satisfies Prisma.SeoActionInclude;

export type ActionDetail = Prisma.SeoActionGetPayload<{ include: typeof DETAIL_INCLUDE }>;

/**
 * One action with everything the detail drawer shows.
 * Ownership is checked here rather than by the caller so no route can forget it.
 */
export async function getActionDetail(userId: string, actionId: string): Promise<ActionDetail> {
  const action = await prisma.seoAction.findUnique({ where: { id: actionId }, include: DETAIL_INCLUDE });
  if (!action) throw new NotFoundError('Action');
  if (action.website.userId !== userId) {
    throw new ForbiddenError('You do not have access to this action.');
  }
  return action;
}

export interface ActionGuardrail {
  /** True when this action may execute with no human in the loop. */
  allowed: boolean;
  reason: string;
  requiresApproval: boolean;
  risk: 'SAFE' | 'MEDIUM' | 'HIGH';
}

/**
 * The single automation guardrail, re-exported through the read model so the UI, the API and
 * the worker all answer "can this run unattended?" the same way.
 */
export function evaluateGuardrail(input: {
  actionType: string;
  autonomyLevel: string;
  autoApproveSafe: boolean;
}): ActionGuardrail {
  const decision = canAutoExecute(input);
  return {
    allowed: decision.allowed,
    reason: decision.reason,
    requiresApproval: !decision.allowed,
    risk: riskBandForActionType(input.actionType),
  };
}
