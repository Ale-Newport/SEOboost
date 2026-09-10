import 'server-only';
import {
  ContentStage,
  ContentStageStatus,
  OpportunityStatus,
  OpportunityType,
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
  formatDateKey,
} from '@seo/shared';

/**
 * Read models for the content pipeline: drafts, briefs, opportunities and the calendar.
 *
 * The pipeline is a state machine over `ContentDraft.stage`, so every list here exposes the
 * stage and its status rather than a derived "percent complete" — the UI should show where a
 * draft actually is, not an invented progress bar.
 */

// ── drafts ───────────────────────────────────────────────────

const DRAFT_LIST_SELECT = {
  id: true,
  websiteId: true,
  briefId: true,
  pageId: true,
  kind: true,
  title: true,
  slug: true,
  metaTitle: true,
  metaDescription: true,
  excerpt: true,
  targetKeyword: true,
  wordCount: true,
  stage: true,
  currentStageStatus: true,
  seoScore: true,
  geoScore: true,
  readabilityScore: true,
  qualityScore: true,
  qualityFlags: true,
  unverifiedClaims: true,
  scheduledFor: true,
  publishedAt: true,
  publishedUrl: true,
  createdAt: true,
  updatedAt: true,
  website: { select: { id: true, name: true, domain: true } },
  brief: { select: { id: true, title: true, targetKeyword: true } },
  page: { select: { id: true, url: true, title: true } },
  _count: { select: { versions: true, stages: true } },
} satisfies Prisma.ContentDraftSelect;

export type ContentDraftListItem = Prisma.ContentDraftGetPayload<{ select: typeof DRAFT_LIST_SELECT }>;

export interface DraftListFilters {
  websiteIds: string[];
  stage?: ContentStage[];
  stageStatus?: ContentStageStatus[];
  search?: string;
  page?: number;
  pageSize?: number;
  order?: 'asc' | 'desc';
}

export async function listDrafts(filters: DraftListFilters): Promise<Paginated<ContentDraftListItem>> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.floor(clamp(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE));
  if (filters.websiteIds.length === 0) return buildPaginated<ContentDraftListItem>([], 0, page, pageSize);

  const search = filters.search?.trim();
  const where: Prisma.ContentDraftWhereInput = {
    websiteId: { in: filters.websiteIds },
    ...(filters.stage?.length ? { stage: { in: filters.stage } } : {}),
    ...(filters.stageStatus?.length ? { currentStageStatus: { in: filters.stageStatus } } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { targetKeyword: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.contentDraft.findMany({
      where,
      select: DRAFT_LIST_SELECT,
      orderBy: [{ updatedAt: filters.order ?? 'desc' }],
      ...paginate(page, pageSize),
    }),
    prisma.contentDraft.count({ where }),
  ]);

  return buildPaginated(items, total, page, pageSize);
}

const DRAFT_DETAIL_INCLUDE = {
  website: { select: { id: true, name: true, domain: true, userId: true } },
  brief: true,
  page: { select: { id: true, url: true, title: true, wordCount: true, seoScore: true } },
  stages: { orderBy: { createdAt: 'asc' } },
  versions: {
    orderBy: { version: 'desc' },
    take: 25,
    select: {
      id: true,
      version: true,
      title: true,
      metaTitle: true,
      metaDescription: true,
      authorType: true,
      authorName: true,
      changeSummary: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ContentDraftInclude;

export type ContentDraftDetail = Prisma.ContentDraftGetPayload<{ include: typeof DRAFT_DETAIL_INCLUDE }>;

/** One draft with its stage history and version list. Ownership is enforced here. */
export async function getDraft(userId: string, draftId: string): Promise<ContentDraftDetail> {
  const draft = await prisma.contentDraft.findUnique({
    where: { id: draftId },
    include: DRAFT_DETAIL_INCLUDE,
  });
  if (!draft) throw new NotFoundError('Content draft');
  if (draft.website.userId !== userId) throw new ForbiddenError('You do not have access to this draft.');
  return draft;
}

/**
 * The draft plus its ownership check, without the stage and version relations.
 *
 * The editor autosaves on a timer, so the write path must not drag the whole version history
 * into memory on every keystroke — only `GET` needs that.
 */
export async function requireDraft(userId: string, draftId: string) {
  const draft = await prisma.contentDraft.findUnique({
    where: { id: draftId },
    include: { website: { select: { id: true, name: true, domain: true, userId: true } } },
  });
  if (!draft) throw new NotFoundError('Content draft');
  if (draft.website.userId !== userId) throw new ForbiddenError('You do not have access to this draft.');
  return draft;
}

/** Claims the fact-check stage could not verify. Publishing with these outstanding is blocked. */
export function unverifiedClaimsOf(draft: { unverifiedClaims: Prisma.JsonValue }): unknown[] {
  const claims = readJson<unknown>(draft.unverifiedClaims, []);
  return Array.isArray(claims) ? claims : [];
}

// ── briefs ───────────────────────────────────────────────────

const BRIEF_SELECT = {
  id: true,
  websiteId: true,
  opportunityId: true,
  title: true,
  targetKeyword: true,
  secondaryKeywords: true,
  intent: true,
  funnelStage: true,
  audience: true,
  suggestedUrl: true,
  titleIdeas: true,
  metaDescription: true,
  outline: true,
  entities: true,
  questions: true,
  competitorWeaknesses: true,
  originalAngle: true,
  supportingEvidence: true,
  internalLinkTargets: true,
  schemaOpportunity: true,
  cta: true,
  geoRecommendations: true,
  targetWordCount: true,
  serpAnalysis: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  website: { select: { id: true, name: true, domain: true } },
  _count: { select: { drafts: true } },
} satisfies Prisma.ContentBriefSelect;

export type ContentBriefListItem = Prisma.ContentBriefGetPayload<{ select: typeof BRIEF_SELECT }>;

export async function listBriefs(filters: {
  websiteIds: string[];
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<ContentBriefListItem>> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.floor(clamp(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE));
  if (filters.websiteIds.length === 0) return buildPaginated<ContentBriefListItem>([], 0, page, pageSize);

  const search = filters.search?.trim();
  const where: Prisma.ContentBriefWhereInput = {
    websiteId: { in: filters.websiteIds },
    ...(filters.status ? { status: filters.status } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { targetKeyword: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.contentBrief.findMany({
      where,
      select: BRIEF_SELECT,
      orderBy: [{ createdAt: 'desc' }],
      ...paginate(page, pageSize),
    }),
    prisma.contentBrief.count({ where }),
  ]);
  return buildPaginated(items, total, page, pageSize);
}

// ── opportunities ────────────────────────────────────────────

const OPPORTUNITY_SELECT = {
  id: true,
  websiteId: true,
  pageId: true,
  keywordId: true,
  clusterId: true,
  type: true,
  status: true,
  title: true,
  targetKeyword: true,
  secondaryKeywords: true,
  suggestedUrl: true,
  reasoning: true,
  evidence: true,
  impactScore: true,
  effortScore: true,
  confidenceScore: true,
  priorityScore: true,
  estimatedTrafficGain: true,
  cannibalizationChecked: true,
  cannibalizationRisk: true,
  existingPageMatch: true,
  discoveredAt: true,
  updatedAt: true,
  expiresAt: true,
  website: { select: { id: true, name: true, domain: true } },
  page: { select: { id: true, url: true, title: true } },
  keyword: { select: { id: true, keyword: true, intent: true, funnelStage: true, searchVolume: true } },
  cluster: { select: { id: true, name: true } },
  _count: { select: { briefs: true } },
} satisfies Prisma.ContentOpportunitySelect;

export type ContentOpportunityListItem = Prisma.ContentOpportunityGetPayload<{
  select: typeof OPPORTUNITY_SELECT;
}>;

export interface OpportunityFilters {
  websiteIds: string[];
  status?: OpportunityStatus[];
  type?: OpportunityType[];
  minPriority?: number;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listOpportunities(
  filters: OpportunityFilters,
): Promise<Paginated<ContentOpportunityListItem>> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));
  const pageSize = Math.floor(clamp(filters.pageSize ?? DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE));
  if (filters.websiteIds.length === 0) {
    return buildPaginated<ContentOpportunityListItem>([], 0, page, pageSize);
  }

  const search = filters.search?.trim();
  const where: Prisma.ContentOpportunityWhereInput = {
    websiteId: { in: filters.websiteIds },
    ...(filters.status?.length ? { status: { in: filters.status } } : {}),
    ...(filters.type?.length ? { type: { in: filters.type } } : {}),
    ...(typeof filters.minPriority === 'number' ? { priorityScore: { gte: filters.minPriority } } : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { targetKeyword: { contains: search, mode: 'insensitive' } },
            { reasoning: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [items, total] = await Promise.all([
    prisma.contentOpportunity.findMany({
      where,
      select: OPPORTUNITY_SELECT,
      orderBy: [{ priorityScore: 'desc' }, { discoveredAt: 'desc' }],
      ...paginate(page, pageSize),
    }),
    prisma.contentOpportunity.count({ where }),
  ]);
  return buildPaginated(items, total, page, pageSize);
}

/** One opportunity with the ownership check, for the accept/reject routes. */
export async function getOpportunity(userId: string, opportunityId: string) {
  const row = await prisma.contentOpportunity.findUnique({
    where: { id: opportunityId },
    include: {
      website: { select: { id: true, name: true, domain: true, userId: true } },
      keyword: { select: { id: true, keyword: true, intent: true, funnelStage: true } },
      page: { select: { id: true, url: true, title: true } },
    },
  });
  if (!row) throw new NotFoundError('Content opportunity');
  if (row.website.userId !== userId) {
    throw new ForbiddenError('You do not have access to this opportunity.');
  }
  return row;
}

// ── calendar ─────────────────────────────────────────────────

export interface CalendarEntry {
  id: string;
  websiteId: string;
  websiteName: string;
  title: string;
  stage: ContentStage;
  stageStatus: ContentStageStatus;
  targetKeyword: string | null;
  wordCount: number;
  /** The day this entry belongs to: publish date, schedule date, or last update. */
  date: string;
  dateKind: 'published' | 'scheduled' | 'updated';
  publishedUrl: string | null;
}

export interface ContentCalendar {
  /** Entries grouped by `YYYY-MM-DD`, newest day first. */
  byDate: Array<{ date: string; entries: CalendarEntry[] }>;
  /** The same entries grouped by pipeline stage, for the board view. */
  byStage: Array<{ stage: ContentStage; entries: CalendarEntry[] }>;
  total: number;
  from: string | null;
  to: string | null;
}

/**
 * The cross-site content calendar.
 *
 * A draft is placed on the day it was published, else the day it is scheduled for, else the
 * day it last moved. Nothing is projected forward — an unscheduled draft has no future date,
 * and the UI shows it in its stage column instead.
 */
export async function getContentCalendar(input: {
  websiteIds: string[];
  from?: Date;
  to?: Date;
  limit?: number;
}): Promise<ContentCalendar> {
  const limit = Math.floor(clamp(input.limit ?? 400, 1, 2000));
  if (input.websiteIds.length === 0) {
    return { byDate: [], byStage: [], total: 0, from: null, to: null };
  }

  const window: Prisma.ContentDraftWhereInput[] = [];
  if (input.from || input.to) {
    const range = {
      ...(input.from ? { gte: input.from } : {}),
      ...(input.to ? { lte: input.to } : {}),
    };
    window.push({ publishedAt: range }, { scheduledFor: range }, { updatedAt: range });
  }

  const drafts = await prisma.contentDraft.findMany({
    where: {
      websiteId: { in: input.websiteIds },
      ...(window.length ? { OR: window } : {}),
    },
    select: {
      id: true,
      websiteId: true,
      title: true,
      stage: true,
      currentStageStatus: true,
      targetKeyword: true,
      wordCount: true,
      scheduledFor: true,
      publishedAt: true,
      publishedUrl: true,
      updatedAt: true,
      website: { select: { name: true } },
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: limit,
  });

  const entries: CalendarEntry[] = drafts.map((draft) => {
    const anchor = draft.publishedAt ?? draft.scheduledFor ?? draft.updatedAt;
    const dateKind: CalendarEntry['dateKind'] = draft.publishedAt
      ? 'published'
      : draft.scheduledFor
        ? 'scheduled'
        : 'updated';
    return {
      id: draft.id,
      websiteId: draft.websiteId,
      websiteName: draft.website.name,
      title: draft.title,
      stage: draft.stage,
      stageStatus: draft.currentStageStatus,
      targetKeyword: draft.targetKeyword,
      wordCount: draft.wordCount,
      date: formatDateKey(anchor),
      dateKind,
      publishedUrl: draft.publishedUrl,
    };
  });

  const dateBuckets = new Map<string, CalendarEntry[]>();
  const stageBuckets = new Map<ContentStage, CalendarEntry[]>();
  for (const entry of entries) {
    const dayList = dateBuckets.get(entry.date) ?? [];
    dayList.push(entry);
    dateBuckets.set(entry.date, dayList);

    const stageList = stageBuckets.get(entry.stage) ?? [];
    stageList.push(entry);
    stageBuckets.set(entry.stage, stageList);
  }

  const byDate = [...dateBuckets.entries()]
    .map(([date, dayEntries]) => ({ date, entries: dayEntries }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  // Stage order follows the pipeline so the board columns read left-to-right in workflow order.
  const stageOrder = Object.values(ContentStage);
  const byStage = stageOrder
    .filter((stage) => stageBuckets.has(stage))
    .map((stage) => ({ stage, entries: stageBuckets.get(stage) ?? [] }));

  return {
    byDate,
    byStage,
    total: entries.length,
    from: byDate.length ? (byDate[byDate.length - 1]?.date ?? null) : null,
    to: byDate.length ? (byDate[0]?.date ?? null) : null,
  };
}
