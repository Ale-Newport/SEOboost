import { prisma } from '@seo/db';
import { findDecayingPages, type DecayingPage } from '@seo/seo-engine';
import { clamp, normalizeUrl, round, truncate } from '@seo/shared';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  GSC_NOT_CONNECTED,
  comparisonWindows,
  gscAggregates,
  hasSearchConsoleData,
  jsonArray,
  loadSite,
  pluralise,
  propose,
  result,
  skipped,
  step,
  throwIfAborted,
  unique,
} from './shared';

const AGENT = 'ContentRefreshAgent' as const;
const ALLOWED_ACTION_TYPES = ['REFRESH_CONTENT'] as const;

// ── Diagnosis (pure) ──────────────────────────────────────────────────────────

export type DecayCause = 'RANKING_LOSS' | 'DEMAND_LOSS' | 'SERP_CHANGE';

export interface DecayDiagnosis {
  cause: DecayCause;
  /** 0-1 confidence in the diagnosis, from how cleanly the signals separate. */
  confidence: number;
  explanation: string;
}

/**
 * Separate the three reasons a page loses clicks, because the right response differs completely:
 * only ranking loss is worth rewriting for. Refreshing a page whose *market* shrank is wasted
 * effort, and refreshing one whose SERP gained an AI overview may not recover the clicks at all.
 */
export function diagnoseDecay(page: DecayingPage): DecayDiagnosis {
  if (page.positionChange > 1.5) {
    // A big position slide with impressions holding up is unambiguous.
    const impressionsHeld = page.impressionsChangePct === null || page.impressionsChangePct > -20;
    return {
      cause: 'RANKING_LOSS',
      confidence: impressionsHeld ? 0.85 : 0.7,
      explanation:
        `Average position moved from ${page.positionBefore} to ${page.positionAfter} ` +
        `(${page.positionChange > 0 ? '+' : ''}${page.positionChange} places) while clicks fell ` +
        `${Math.abs(Math.round(page.clicksChangePct))}%. Something now outranks this page.`,
    };
  }

  if (page.impressionsChangePct !== null && page.impressionsChangePct < -20) {
    return {
      cause: 'DEMAND_LOSS',
      confidence: 0.75,
      explanation:
        `Position held at ${page.positionAfter} but impressions fell ${Math.abs(Math.round(page.impressionsChangePct))}%. ` +
        'Fewer people are searching for this — seasonality or a shrinking topic, not a content problem.',
    };
  }

  return {
    cause: 'SERP_CHANGE',
    confidence: 0.55,
    explanation:
      `Position (${page.positionAfter}) and impressions are roughly stable but clicks fell ` +
      `${Math.abs(Math.round(page.clicksChangePct))}%. That pattern usually means the result page itself changed — ` +
      'an AI overview, more ads, or a new rich result absorbing the click.',
  };
}

/** Impact of fixing a decayed page: the clicks it used to earn, normalised against the site. */
export function refreshImpact(page: DecayingPage, siteMaxClicks: number): number {
  const lost = Math.max(0, page.clicksBefore - page.clicksAfter);
  const share = siteMaxClicks > 0 ? lost / siteMaxClicks : 0;
  const severityBoost = page.severity === 'high' ? 0.25 : page.severity === 'medium' ? 0.15 : 0.05;
  return round(clamp(share + severityBoost), 3);
}

// ── Agent ─────────────────────────────────────────────────────────────────────

async function run(ctx: AgentContext): Promise<AgentResult> {
  const site = await loadSite(ctx.websiteId);

  if (!(await hasSearchConsoleData(ctx.websiteId))) {
    return skipped('No Search Console data for this site.', GSC_NOT_CONNECTED);
  }

  const maxActions = typeof ctx.input.maxActions === 'number' ? Math.max(1, Math.min(25, ctx.input.maxActions)) : 8;
  const windows = comparisonWindows();

  const [current, previous] = await Promise.all([
    step(ctx, 'get_search_console_queries', { window: 'current-28d' }, () =>
      gscAggregates(ctx.websiteId, windows.current, 5000),
    ),
    step(ctx, 'get_search_console_queries', { window: 'previous-28d' }, () =>
      gscAggregates(ctx.websiteId, windows.previous, 5000),
    ),
  ]);

  if (previous.length === 0) {
    return skipped(
      'Not enough history to detect decay.',
      'Decay detection compares two 28-day windows and there is no data for the earlier one. ' +
        'Backfill Search Console history (Settings → Integrations → Search Console → Backfill) and re-run.',
    );
  }

  const decaying = findDecayingPages({ current, previous });
  if (decaying.length === 0) {
    return result({
      summary: `No pages are losing traffic on ${site.domain} between the two 28-day windows.`,
      confidence: 0.85,
      data: { pagesChecked: unique(previous.map((row) => row.page)).length, decaying: 0 },
    });
  }

  const diagnosed = decaying.map((page) => ({ page, diagnosis: diagnoseDecay(page) }));
  const rankingLoss = diagnosed.filter((entry) => entry.diagnosis.cause === 'RANKING_LOSS');
  const maxClicks = Math.max(...decaying.map((page) => page.clicksBefore), 1);

  // Only ranking decay earns an action; the other two get reported so the user understands why
  // the platform is *not* proposing a rewrite.
  const pageIdByUrl = await pageIndex(ctx.websiteId);
  const actions = new ActionCollector();

  for (const entry of rankingLoss.slice(0, maxActions)) {
    throwIfAborted(ctx);
    const { page, diagnosis } = entry;
    const subTopics = await competitorSubTopics(ctx.websiteId, page.lostQueries);
    const normalized = normalizeUrl(page.page);
    const pageId = normalized ? pageIdByUrl.get(normalized) ?? null : null;

    const serpNote = subTopics.available
      ? `Competitors now ranking for the lost queries cover: ${subTopics.topics.slice(0, 8).join('; ')}.`
      : 'No SERP data is stored for the lost queries, so the specific sub-topics competitors now cover are unknown — ' +
        'connect a SERP provider for that detail. The lost queries themselves are listed in the evidence.';

    await propose(ctx, actions, {
      type: 'REFRESH_CONTENT',
      title: `Refresh ${truncate(page.page, 80, '…')} — clicks down ${Math.abs(Math.round(page.clicksChangePct))}%`,
      reasoning:
        `${diagnosis.explanation} ${page.lostQueries.length > 0 ? `Queries that stopped ranking: ${page.lostQueries.slice(0, 5).join(', ')}. ` : ''}` +
        `${serpNote} Update the page against what now ranks: close the sub-topic gaps, re-verify facts and dates, ` +
        'and strengthen the direct answer at the top rather than simply adding words.',
      evidence: {
        cause: diagnosis.cause,
        clicksBefore: page.clicksBefore,
        clicksAfter: page.clicksAfter,
        clicksChangePct: page.clicksChangePct,
        impressionsChangePct: page.impressionsChangePct,
        positionBefore: page.positionBefore,
        positionAfter: page.positionAfter,
        lostQueries: page.lostQueries,
        competitorSubTopics: subTopics.topics,
        serpDataAvailable: subTopics.available,
        windows: {
          current: { start: windows.current.start, end: windows.current.end },
          previous: { start: windows.previous.start, end: windows.previous.end },
        },
      },
      affectedUrls: [page.page],
      payload: { pageId, url: page.page, lostQueries: page.lostQueries, subTopics: subTopics.topics },
      impact: refreshImpact(page, maxClicks),
      confidence: diagnosis.confidence,
      effort: 3,
      sourceType: 'DecayingPage',
      sourceId: `${page.page}:${windows.current.end.toISOString().slice(0, 10)}`,
      // A refresh means rewriting prose, which runs through the content pipeline and a reviewer.
      advisory: 'Rewriting the page runs through the content pipeline; the platform does not edit prose unattended.',
    });
  }

  return result({
    summary:
      `${decaying.length} ${pluralise(decaying.length, 'page')} lost traffic: ${rankingLoss.length} to ranking loss, ` +
      `${diagnosed.filter((entry) => entry.diagnosis.cause === 'DEMAND_LOSS').length} to falling demand, ` +
      `${diagnosed.filter((entry) => entry.diagnosis.cause === 'SERP_CHANGE').length} to SERP changes. ` +
      `Proposed ${actions.actionsCreated.length} refresh ${pluralise(actions.actionsCreated.length, 'action')} — only for genuine ranking decay.`,
    confidence: 0.75,
    actionsCreated: actions.actionsCreated,
    approvalsCreated: actions.approvalsCreated,
    findings: diagnosed.slice(0, 30).map((entry) => ({
      kind: 'decaying-page',
      url: entry.page.page,
      cause: entry.diagnosis.cause,
      explanation: entry.diagnosis.explanation,
      clicksChangePct: entry.page.clicksChangePct,
      positionChange: entry.page.positionChange,
      severity: entry.page.severity,
      lostQueries: entry.page.lostQueries.slice(0, 5),
      actionable: entry.diagnosis.cause === 'RANKING_LOSS',
    })),
    data: {
      decaying: decaying.length,
      rankingLoss: rankingLoss.length,
      windows: {
        current: { start: windows.current.start, end: windows.current.end },
        previous: { start: windows.previous.start, end: windows.previous.end },
      },
      policy:
        'Only ranking decay produces a refresh action. Falling search demand and SERP layout changes are reported ' +
        'but not actioned, because rewriting the page would not recover those clicks.',
    },
  });
}

async function pageIndex(websiteId: string): Promise<Map<string, string>> {
  const pages = await prisma.page.findMany({
    where: { websiteId, isActive: true },
    select: { id: true, normalizedUrl: true },
    take: 20_000,
  });
  return new Map(pages.map((page) => [page.normalizedUrl, page.id]));
}

/**
 * What the pages now outranking us actually cover, taken from stored SERP snapshots for the
 * queries this page lost. Returns `available: false` rather than guessing when there is no
 * SERP provider — a fabricated competitor sub-topic is worse than an honest gap.
 */
async function competitorSubTopics(
  websiteId: string,
  lostQueries: readonly string[],
): Promise<{ available: boolean; topics: string[] }> {
  if (lostQueries.length === 0) return { available: false, topics: [] };

  const snapshots = await prisma.serpSnapshot.findMany({
    where: { websiteId, query: { in: [...lostQueries] } },
    orderBy: { capturedAt: 'desc' },
    take: 10,
    select: { results: true, peopleAlsoAsk: true },
  });
  if (snapshots.length === 0) return { available: false, topics: [] };

  const topics = unique(
    snapshots.flatMap((snapshot) => [
      ...jsonArray(snapshot.results)
        .slice(0, 5)
        .flatMap((entry) => (typeof entry.title === 'string' ? [entry.title] : [])),
      ...jsonArray(snapshot.peopleAlsoAsk).flatMap((entry) =>
        typeof entry.question === 'string' ? [entry.question] : [],
      ),
    ]),
  );
  return { available: true, topics: topics.slice(0, 20) };
}

export const contentRefreshAgent: AgentDefinition = {
  name: AGENT,
  label: 'Content refresh',
  description:
    'Finds pages losing traffic, separates ranking decay from falling demand, and proposes refreshes only for genuine ranking loss.',
  allowedActionTypes: [...ALLOWED_ACTION_TYPES],
  tools: ['get_search_console_queries'],
  requiresAi: false,
  run,
};

registerAgent(contentRefreshAgent);
