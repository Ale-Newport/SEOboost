import 'server-only';
import {
  ActionRisk,
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
  type Paginated,
  clamp,
} from '@seo/shared';

/**
 * Read model for the approval queue.
 *
 * An approval is the human checkpoint in front of a change to a live site, so this module is
 * deliberately conservative about what it exposes: the stored diff and payload, never anything
 * derived or estimated. `payload`/`diff` are free-form JSON written by the agent that raised
 * the approval, and are passed through unchanged.
 */

const APPROVAL_SELECT = {
  id: true,
  websiteId: true,
  actionId: true,
  userId: true,
  kind: true,
  title: true,
  description: true,
  risk: true,
  status: true,
  diff: true,
  payload: true,
  editedPayload: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  updatedAt: true,
  website: { select: { id: true, name: true, domain: true } },
  user: { select: { id: true, name: true, email: true } },
  action: {
    select: {
      id: true,
      type: true,
      title: true,
      status: true,
      risk: true,
      reasoning: true,
      affectedUrls: true,
      priorityScore: true,
    },
  },
} satisfies Prisma.ApprovalSelect;

type ApprovalRow = Prisma.ApprovalGetPayload<{ select: typeof APPROVAL_SELECT }>;

/** One field-level change as the diff viewer renders it. */
export interface ApprovalDiffEntry {
  field: string;
  before: string | null;
  after: string | null;
}

export interface ApprovalListItem {
  id: string;
  websiteId: string;
  website: { id: string; name: string; domain: string };
  actionId: string | null;
  action: ApprovalRow['action'];
  kind: string;
  title: string;
  description: string | null;
  risk: ActionRisk;
  status: ApprovalStatus;
  /** Normalised field diff when the agent wrote one in a recognisable shape, else `[]`. */
  diff: ApprovalDiffEntry[];
  /** The raw diff JSON, for shapes the normaliser does not recognise. */
  rawDiff: unknown;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  decidedBy: { id: string; name: string | null; email: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

function isDiffEntry(value: unknown): value is ApprovalDiffEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.field === 'string' && 'before' in entry && 'after' in entry;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Accept both diff shapes agents produce: an array of `{ field, before, after }` (what the
 * adapter layer emits) and a `{ before, after }` object of field maps. Anything else is
 * passed through untouched as `rawDiff` rather than being guessed at.
 */
export function normaliseDiff(raw: unknown): ApprovalDiffEntry[] {
  if (Array.isArray(raw)) {
    return raw.filter(isDiffEntry).map((entry) => ({
      field: entry.field,
      before: stringOrNull(entry.before),
      after: stringOrNull(entry.after),
    }));
  }
  if (typeof raw !== 'object' || raw === null) return [];

  const record = raw as Record<string, unknown>;
  const before = record.before;
  const after = record.after;
  if (typeof before !== 'object' && typeof after !== 'object') return [];

  const beforeMap = (before ?? {}) as Record<string, unknown>;
  const afterMap = (after ?? {}) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(beforeMap), ...Object.keys(afterMap)])];
  return fields.map((field) => ({
    field,
    before: stringOrNull(beforeMap[field]),
    after: stringOrNull(afterMap[field]),
  }));
}

function toListItem(row: ApprovalRow): ApprovalListItem {
  const editedPayload = row.editedPayload === null ? null : readJson<Record<string, unknown>>(row.editedPayload, {});
  return {
    id: row.id,
    websiteId: row.websiteId,
    website: row.website,
    actionId: row.actionId,
    action: row.action,
    kind: row.kind,
    title: row.title,
    description: row.description,
    risk: row.risk,
    status: row.status,
    diff: normaliseDiff(row.diff),
    rawDiff: row.diff,
    payload: readJson<Record<string, unknown>>(row.payload, {}),
    editedPayload,
    decidedAt: row.decidedAt,
    decisionNote: row.decisionNote,
    decidedBy: row.user,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export interface ApprovalListFilters {
  websiteIds: string[];
  status?: ApprovalStatus[];
  risk?: ActionRisk[];
  kind?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  order?: 'asc' | 'desc';
}

/** One page of the approval queue. Defaults to everything still pending, oldest first. */
export async function listApprovals(filters: ApprovalListFilters): Promise<Paginated<ApprovalListItem>> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.floor(clamp(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE));
  if (filters.websiteIds.length === 0) return buildPaginated<ApprovalListItem>([], 0, page, pageSize);

  const search = filters.search?.trim();
  const where: Prisma.ApprovalWhereInput = {
    websiteId: { in: filters.websiteIds },
    status: { in: filters.status?.length ? filters.status : [ApprovalStatus.PENDING] },
    ...(filters.risk?.length ? { risk: { in: filters.risk } } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { description: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.approval.findMany({
      where,
      select: APPROVAL_SELECT,
      // Oldest first: the queue is a to-do list, and the oldest decision is the one blocking work.
      orderBy: [{ createdAt: filters.order ?? 'asc' }],
      ...paginate(page, pageSize),
    }),
    prisma.approval.count({ where }),
  ]);

  return buildPaginated(rows.map(toListItem), total, page, pageSize);
}

/** Pending approvals grouped by risk band, for the queue header and the sidebar badge. */
export async function getApprovalSummary(websiteIds: string[]): Promise<{
  pending: number;
  byRisk: Record<string, number>;
  /** Pending items that `bulk-approve-safe` would act on. */
  safePending: number;
}> {
  if (websiteIds.length === 0) return { pending: 0, byRisk: {}, safePending: 0 };

  const groups = await prisma.approval.groupBy({
    by: ['risk'],
    where: { websiteId: { in: websiteIds }, status: ApprovalStatus.PENDING },
    _count: { _all: true },
  });

  const byRisk: Record<string, number> = {};
  let pending = 0;
  for (const group of groups) {
    byRisk[group.risk] = group._count._all;
    pending += group._count._all;
  }
  return { pending, byRisk, safePending: byRisk[ActionRisk.SAFE] ?? 0 };
}

/** One approval, with the ownership check. */
export async function getApproval(userId: string, approvalId: string): Promise<ApprovalListItem> {
  const row = await prisma.approval.findUnique({
    where: { id: approvalId },
    select: { ...APPROVAL_SELECT, website: { select: { id: true, name: true, domain: true, userId: true } } },
  });
  if (!row) throw new NotFoundError('Approval');
  if (row.website.userId !== userId) throw new ForbiddenError('You do not have access to this approval.');

  const { userId: _ownerId, ...website } = row.website;
  return toListItem({ ...row, website });
}
