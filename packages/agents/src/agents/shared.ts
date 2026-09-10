import type { PromptKnowledgeBase } from '@seo/ai';
import {
  type ActionType,
  type AutonomyLevel,
  type NotificationSeverity,
  isUniqueViolation,
  json,
  prisma,
} from '@seo/db';
import type { QueryPageAggregate } from '@seo/seo-engine';
import {
  AUTONOMY_DESCRIPTIONS,
  clamp,
  errorMessage,
  lastNDays,
  previousPeriod,
  round,
  safeDivide,
  type DateRange,
} from '@seo/shared';
import { createActionFromAgent } from '../runtime/run';
import type { AgentContext, AgentResult } from '../types';

/**
 * Cross-agent plumbing.
 *
 * Agents differ in *what* they conclude, not in how they read a site or write an action. The
 * reads here are the ones no tool covers (query x page pairs, crawl joins); the write path is a
 * thin wrapper over the runtime's `createActionFromAgent`, which is where the guardrails live.
 */

/** Search Console publishes data ~2-3 days behind; every window below respects that lag. */
export const GSC_LAG_DAYS = 3;

// ── Result builders ───────────────────────────────────────────────────────────

/**
 * The typed "I could not run" result. Agents never throw for a missing prerequisite and never
 * substitute invented output: the reason must say exactly what an operator has to configure.
 */
export function skipped(summary: string, reason: string, data: Record<string, unknown> = {}): AgentResult {
  return {
    summary,
    confidence: 0,
    actionsCreated: [],
    approvalsCreated: [],
    findings: [],
    data,
    skipped: true,
    skipReason: reason,
  };
}

export interface ResultDraft {
  summary: string;
  confidence: number;
  actionsCreated?: string[];
  approvalsCreated?: string[];
  findings?: unknown[];
  data?: Record<string, unknown>;
}

export function result(draft: ResultDraft): AgentResult {
  return {
    summary: draft.summary,
    confidence: draft.confidence,
    actionsCreated: draft.actionsCreated ?? [],
    approvalsCreated: draft.approvalsCreated ?? [],
    findings: draft.findings ?? [],
    data: draft.data ?? {},
  };
}

/**
 * Run one gather step and put it in the run transcript.
 *
 * Agents are only trustworthy if a human can see what they looked at, so every non-trivial read
 * is recorded with its arguments and a small summary of what came back.
 */
export async function step<T>(
  ctx: AgentContext,
  name: string,
  args: Record<string, unknown>,
  fn: () => Promise<T>,
  summarise: (value: T) => unknown = defaultSummary,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const value = await fn();
    ctx.recordToolCall(name, args, summarise(value), Date.now() - startedAt);
    return value;
  } catch (err) {
    ctx.recordToolCall(name, args, { error: errorMessage(err) }, Date.now() - startedAt);
    throw err;
  }
}

function defaultSummary(value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length };
  if (value && typeof value === 'object') return { keys: Object.keys(value as Record<string, unknown>).length };
  return value;
}

/** Cooperative cancellation: long agent loops check this between batches. */
export function throwIfAborted(ctx: AgentContext): void {
  if (ctx.signal?.aborted) throw new Error('Agent run cancelled');
}

// ── Site context ──────────────────────────────────────────────────────────────

export type SiteContext = NonNullable<Awaited<ReturnType<typeof loadSiteContextRaw>>>;

async function loadSiteContextRaw(websiteId: string) {
  return prisma.website.findUnique({
    where: { id: websiteId },
    include: { settings: true, knowledgeBase: true },
  });
}

/** Website row plus its settings and knowledge base — the input every agent starts from. */
export async function loadSite(websiteId: string): Promise<SiteContext> {
  const site = await loadSiteContextRaw(websiteId);
  if (!site) throw new Error(`Website ${websiteId} not found`);
  return site;
}

export function siteUrl(site: { protocol: string; domain: string }): string {
  return `${site.protocol}://${site.domain}`;
}

export function autonomyOf(site: SiteContext): { level: AutonomyLevel; autoApproveSafe: boolean } {
  return {
    level: site.settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY',
    autoApproveSafe: site.settings?.autoApproveSafe ?? false,
  };
}

/** Verified brand facts only. Unverified facts are never handed to a model. */
export async function loadVerifiedFacts(websiteId: string, take = 100) {
  return prisma.brandFact.findMany({
    where: { websiteId, verified: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    orderBy: { updatedAt: 'desc' },
    take,
    select: { fact: true, category: true, source: true, sourceUrl: true, verified: true },
  });
}

/**
 * Convert the `KnowledgeBase` row into the plain shape the prompt templates take.
 *
 * The Json columns are user-editable, so every field is validated structurally rather than cast:
 * a malformed `products` array must degrade to "no products", never crash a content run.
 */
export function toPromptKnowledgeBase(
  kb: SiteContext['knowledgeBase'],
): PromptKnowledgeBase | null {
  if (!kb) return null;
  return {
    businessDescription: kb.businessDescription,
    audience: kb.audience,
    toneOfVoice: kb.toneOfVoice,
    brandStyle: kb.brandStyle,
    preferredCta: kb.preferredCta,
    writingGuidelines: kb.writingGuidelines,
    prohibitedClaims: kb.prohibitedClaims,
    uniqueValueProps: kb.uniqueValueProps,
    products: jsonArray(kb.products).flatMap((entry) => {
      const name = typeof entry.name === 'string' ? entry.name : null;
      if (!name) return [];
      return [
        {
          name,
          description: typeof entry.description === 'string' ? entry.description : null,
          url: typeof entry.url === 'string' ? entry.url : null,
        },
      ];
    }),
    terminology: jsonArray(kb.terminology).flatMap((entry) =>
      typeof entry.term === 'string' && typeof entry.definition === 'string'
        ? [{ term: entry.term, definition: entry.definition }]
        : [],
    ),
    authorBios: jsonArray(kb.authorBios).flatMap((entry) => {
      const name = typeof entry.name === 'string' ? entry.name : null;
      if (!name) return [];
      return [
        {
          name,
          title: typeof entry.title === 'string' ? entry.title : null,
          bio: typeof entry.bio === 'string' ? entry.bio : null,
          url: typeof entry.url === 'string' ? entry.url : null,
        },
      ];
    }),
  };
}

// ── Search Console reads ──────────────────────────────────────────────────────

export interface GscWindow {
  range: DateRange;
  rows: QueryPageAggregate[];
}

/**
 * Query × page aggregates for a window.
 *
 * `position` is the mean of the daily average positions rather than an impression-weighted mean:
 * the weighted form needs a raw scan of every row, and on a busy site that is tens of thousands
 * of rows per run. The approximation is stated wherever the number is surfaced.
 * Rows are capped at `take` by impressions so one agent run has a bounded cost.
 */
export async function gscAggregates(
  websiteId: string,
  range: DateRange,
  take = 5000,
): Promise<QueryPageAggregate[]> {
  const rows = await prisma.gscQueryMetric.groupBy({
    by: ['query', 'page'],
    where: { websiteId, date: { gte: range.start, lte: range.end } },
    _sum: { clicks: true, impressions: true },
    _avg: { position: true },
    orderBy: { _sum: { impressions: 'desc' } },
    take,
  });

  const out: QueryPageAggregate[] = [];
  for (const row of rows) {
    const impressions = row._sum.impressions ?? 0;
    if (impressions <= 0) continue;
    const clicks = row._sum.clicks ?? 0;
    out.push({
      query: row.query,
      page: row.page,
      clicks,
      impressions,
      ctr: round(safeDivide(clicks, impressions), 4),
      position: round(row._avg.position ?? 0, 2),
    });
  }
  return out;
}

/** The standard 28-day window and the equal-length window before it. */
export function comparisonWindows(days = 28, now = new Date()): { current: DateRange; previous: DateRange } {
  const current = lastNDays(days, GSC_LAG_DAYS, now);
  return { current, previous: previousPeriod(current) };
}

/** True when the site has any Search Console rows at all — the prerequisite for every GSC agent. */
export async function hasSearchConsoleData(websiteId: string): Promise<boolean> {
  const row = await prisma.gscQueryMetric.findFirst({ where: { websiteId }, select: { id: true } });
  return row !== null;
}

export const GSC_NOT_CONNECTED =
  'No Search Console data has been imported for this site. Connect Google Search Console in ' +
  'Settings → Integrations and run a sync, then re-run this agent.';

export const NO_CRAWL =
  'This site has never been crawled successfully. Run a crawl (Site → Crawl) so the agent has ' +
  'pages, links and page text to work from.';

/** Most recent completed crawl, or null. Agents that need page content start here. */
export async function latestCrawl(websiteId: string) {
  return prisma.crawl.findFirst({
    where: { websiteId, status: 'COMPLETED' },
    orderBy: { finishedAt: 'desc' },
    select: { id: true, finishedAt: true, sitemapUrls: true, pagesCrawled: true },
  });
}

// ── Action writing ────────────────────────────────────────────────────────────

export interface ActionProposal {
  type: ActionType;
  title: string;
  reasoning: string;
  evidence?: Record<string, unknown>;
  affectedUrls?: string[];
  payload?: Record<string, unknown>;
  /** 0-1 expected benefit if it works. */
  impact: number;
  /** 0-1 confidence in the diagnosis and the fix. */
  confidence: number;
  /** 0-1 relevance to the site's conversion goal. Defaults to 0.5 — "unknown", not "irrelevant". */
  businessValue?: number;
  /** 1-5, where 1 is trivial. */
  effort: number;
  sourceType?: string;
  /** Stable id of the thing that caused this proposal; the runtime uses it to suppress duplicates. */
  sourceId?: string;
  requiredAgent?: string;
  /**
   * Set when the platform cannot apply the change itself — it needs a person, a credential or a
   * decision. Recorded in the evidence so the operator sees it; the autonomy guard still has the
   * final say on whether anything runs automatically.
   */
  advisory?: string;
}

export interface ProposalOutcome {
  actionId: string;
  approvalId: string | null;
  /** False when an equivalent proposal was already open and was returned instead. */
  created: boolean;
  reason: string;
}

/**
 * Propose one action.
 *
 * A thin wrapper over `createActionFromAgent` so every agent reads the same, but the guardrails
 * live in the runtime, not here: the allow-list check, the priority scoring against this site's
 * measured history, the risk band and the approval decision all happen there, once, where an
 * agent cannot route around them.
 */
export async function proposeAction(
  ctx: AgentContext,
  proposal: ActionProposal,
): Promise<ProposalOutcome> {
  const outcome = await createActionFromAgent(ctx, {
    type: proposal.type,
    title: proposal.title,
    reasoning: proposal.reasoning,
    evidence: {
      ...(proposal.evidence ?? {}),
      ...(proposal.advisory ? { advisory: proposal.advisory } : {}),
    },
    affectedUrls: proposal.affectedUrls ?? [],
    payload: proposal.payload ?? {},
    impact: clamp(proposal.impact),
    confidence: clamp(proposal.confidence),
    businessValue: clamp(proposal.businessValue ?? 0.5),
    effort: proposal.effort,
    sourceType: proposal.sourceType ?? null,
    sourceId: proposal.sourceId ?? null,
    requiredAgent: proposal.requiredAgent ?? null,
  });

  return {
    actionId: outcome.actionId,
    approvalId: outcome.approvalId,
    created: outcome.created,
    reason: outcome.reason,
  };
}

/** Collects what a run created, so an agent never has to track two arrays by hand. */
export class ActionCollector {
  readonly actionsCreated: string[] = [];
  readonly approvalsCreated: string[] = [];
  private duplicates = 0;

  add(outcome: ProposalOutcome): boolean {
    if (!outcome.created) {
      this.duplicates++;
      return false;
    }
    this.actionsCreated.push(outcome.actionId);
    if (outcome.approvalId) this.approvalsCreated.push(outcome.approvalId);
    return true;
  }

  get skippedDuplicates(): number {
    return this.duplicates;
  }
}

/** Propose an action and record the outcome in one call. Returns true when a new row was created. */
export async function propose(
  ctx: AgentContext,
  collector: ActionCollector,
  proposal: ActionProposal,
): Promise<boolean> {
  return collector.add(await proposeAction(ctx, proposal));
}

// ── Notifications ─────────────────────────────────────────────────────────────

export interface NotificationDraft {
  websiteId: string;
  userId?: string | null;
  type: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  link?: string | null;
  data?: Record<string, unknown>;
  /** Globally unique; a repeat detection with the same key is dropped instead of spamming. */
  dedupeKey: string;
}

/** Create a notification unless one with the same dedupe key already exists. */
export async function notifyOnce(draft: NotificationDraft): Promise<boolean> {
  try {
    await prisma.notification.create({
      data: {
        websiteId: draft.websiteId,
        userId: draft.userId ?? null,
        type: draft.type,
        severity: draft.severity,
        title: draft.title,
        message: draft.message,
        link: draft.link ?? null,
        data: json(draft.data ?? {}),
        dedupeKey: draft.dedupeKey,
      },
    });
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a Json column (or any stored blob) as an array of objects.
 * Json columns are user- and model-writable, so their shape is checked, never asserted.
 */
export function jsonArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const entries: unknown[] = value;
  return entries.filter(isRecord);
}

/** Read a Json column as a record. */
export function jsonObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Read a Json column as a string array, dropping anything that is not a string. */
export function jsonStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries: unknown[] = value;
  return entries.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Pluralise a noun for operator-facing copy.
 *
 * The default used to be a bare `+ 's'`, which produced "8 fixs" and "3 opportunitys" in agent
 * summaries. Callers can still pass an explicit plural; the rules below just stop the obvious
 * cases from needing one.
 */
export function pluralise(count: number, singular: string, plural?: string): string {
  if (count === 1) return singular;
  if (plural) return plural;
  if (/[^aeiou]y$/i.test(singular)) return `${singular.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(singular)) return `${singular}es`;
  return `${singular}s`;
}

/** Deduplicate while preserving order. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

// ── Strategy inputs ───────────────────────────────────────────────────────────

/**
 * The hard constraints handed to the SEO Manager's reasoning prompt.
 *
 * These are not suggestions to the model — they mirror the guardrails the runtime enforces
 * anyway (`canAutoExecute`, `ALWAYS_REQUIRES_APPROVAL`). Stating them in the prompt stops the
 * plan from promising work the platform would then refuse to do, which reads as broken.
 */
export function buildStrategyConstraints(
  autonomyLevel: AutonomyLevel,
  observedResultCount: number,
): string[] {
  const description = AUTONOMY_DESCRIPTIONS[autonomyLevel];
  const constraints: string[] = [
    `This site runs at ${description.label}: ${description.description}`,
    description.autoExecutes.length > 0
      ? `Only these action types may run without a human: ${description.autoExecutes.join(', ')}. Everything else must be framed as a proposal awaiting approval.`
      : 'Nothing executes automatically on this site. Every recommendation must be framed as a proposal for the operator to approve.',
    `Redirects, page consolidations and custom actions ALWAYS require explicit human approval, whatever the autonomy level. Never describe them as automatic.`,
    'Never recommend creating a new page when an existing page could be improved to target the query — say which page and why.',
    'Never invent metrics. Every number you cite must come from the site data provided above.',
    'Prefer fewer, higher-confidence actions over a long list. An unactioned plan is worth nothing.',
  ];

  constraints.push(
    observedResultCount === 0
      ? 'No past action on this site has been measured yet, so you have no outcome history to reason from. Say so plainly rather than implying a track record, and prefer low-risk actions that will produce a measurable signal.'
      : `${observedResultCount} past action${observedResultCount === 1 ? ' has' : 's have'} been measured on this site. Reference those observed results explicitly when they support or contradict a recommendation.`,
  );

  return constraints;
}

// ── Action history ────────────────────────────────────────────────────────────

export interface ActionHistory {
  /** Actions still open (proposed, awaiting approval, queued or executing). */
  open: Array<{ id: string; type: string; title: string; status: string; priorityScore: number; affectedUrls: string[] }>;
  /** Recently completed actions, newest first. */
  completed: Array<{ id: string; type: string; title: string; completedAt: Date | null; affectedUrls: string[] }>;
  /** Counts by action type over the window, so an agent can avoid repeating itself. */
  countsByType: Record<string, number>;
  /** URLs an action already targets, so two agents do not both queue work on the same page. */
  urlsUnderWork: Set<string>;
}

/**
 * What has already been proposed or done for a site.
 *
 * Agents call this before proposing so the queue does not fill with near-duplicates. The runtime
 * also de-duplicates by `sourceId`, but that only catches the same cause — this catches two
 * different agents independently deciding to work on the same URL.
 */
export async function loadActionHistory(websiteId: string, withinDays = 60): Promise<ActionHistory> {
  const since = new Date(Date.now() - withinDays * 86_400_000);

  const [open, completed] = await Promise.all([
    prisma.seoAction.findMany({
      where: { websiteId, status: { in: ['PROPOSED', 'AWAITING_APPROVAL', 'QUEUED', 'APPROVED', 'EXECUTING'] } },
      orderBy: { priorityScore: 'desc' },
      take: 100,
      select: { id: true, type: true, title: true, status: true, priorityScore: true, affectedUrls: true },
    }),
    prisma.seoAction.findMany({
      where: { websiteId, status: { in: ['COMPLETED', 'MEASURING', 'EVALUATED'] }, completedAt: { gte: since } },
      orderBy: { completedAt: 'desc' },
      take: 50,
      select: { id: true, type: true, title: true, completedAt: true, affectedUrls: true },
    }),
  ]);

  const countsByType: Record<string, number> = {};
  const urlsUnderWork = new Set<string>();
  for (const action of open) {
    countsByType[action.type] = (countsByType[action.type] ?? 0) + 1;
    for (const url of action.affectedUrls) urlsUnderWork.add(url);
  }
  for (const action of completed) {
    countsByType[action.type] = (countsByType[action.type] ?? 0) + 1;
  }

  return { open, completed, countsByType, urlsUnderWork };
}
