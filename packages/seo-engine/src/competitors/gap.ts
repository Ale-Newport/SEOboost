import { clamp, logNormalize, normalizeKeyword, round } from '@seo/shared';

export interface CompetitorKeywordRow {
  competitorDomain: string;
  keyword: string;
  position: number | null;
  url: string | null;
  estimatedVolume: number | null;
}

export interface OurKeywordRow {
  keyword: string;
  position: number | null;
  impressions: number;
  url: string | null;
}

export interface KeywordGap {
  keyword: string;
  competitorDomains: string[];
  bestCompetitorPosition: number;
  ourPosition: number | null;
  estimatedVolume: number | null;
  /** Number of tracked competitors ranking top-10 — evidence the query matters in this niche. */
  competitorCount: number;
  gapScore: number;
  gapType: 'missing' | 'underperforming';
  reason: string;
}

export interface CompetitorOverview {
  domain: string;
  sharedKeywords: number;
  gapKeywords: number;
  totalKeywords: number;
  avgPosition: number | null;
  serpOverlapPct: number;
  /** Topics where this competitor consistently outranks us. */
  topicalStrengths: string[];
  wins: number;
  losses: number;
}

/**
 * Keyword gap analysis: what competitors rank for that we do not, ranked by how much it is worth
 * pursuing rather than by raw count. A 3,000-row gap list is useless; the top 50 with reasons is not.
 */
export function analyseKeywordGaps(
  ourKeywords: OurKeywordRow[],
  competitorKeywords: CompetitorKeywordRow[],
  options: { maxResults?: number; underperformingThreshold?: number } = {},
): KeywordGap[] {
  const maxResults = options.maxResults ?? 500;
  const underperforming = options.underperformingThreshold ?? 10;

  const ours = new Map<string, OurKeywordRow>();
  for (const row of ourKeywords) ours.set(normalizeKeyword(row.keyword), row);

  const byKeyword = new Map<string, CompetitorKeywordRow[]>();
  for (const row of competitorKeywords) {
    if (row.position === null || row.position > 20) continue; // only meaningful rankings
    const key = normalizeKeyword(row.keyword);
    const list = byKeyword.get(key) ?? [];
    list.push(row);
    byKeyword.set(key, list);
  }

  const maxVolume = Math.max(
    1000,
    ...competitorKeywords.map((r) => r.estimatedVolume ?? 0),
  );

  const gaps: KeywordGap[] = [];
  for (const [normalized, rows] of byKeyword) {
    const ourRow = ours.get(normalized);
    const ourPosition = ourRow?.position ?? null;

    const gapType: KeywordGap['gapType'] =
      ourPosition === null ? 'missing' : ourPosition > underperforming ? 'underperforming' : 'missing';
    if (ourPosition !== null && ourPosition <= underperforming) continue; // we already rank well

    const domains = [...new Set(rows.map((r) => r.competitorDomain))];
    const bestPosition = Math.min(...rows.map((r) => r.position ?? 100));
    const volume = rows.map((r) => r.estimatedVolume).find((v) => v !== null && v !== undefined) ?? null;

    // Score: several competitors ranking well is the strongest signal that a query is worth having.
    const competitionSignal = clamp(domains.length / 3);
    const positionSignal = clamp(1 - (bestPosition - 1) / 20);
    const volumeSignal = volume !== null ? logNormalize(volume, maxVolume) : 0.4;
    const proximitySignal = ourPosition !== null ? clamp(1 - (ourPosition - underperforming) / 60) : 0.35;

    const gapScore = round(
      (competitionSignal * 0.3 + positionSignal * 0.25 + volumeSignal * 0.25 + proximitySignal * 0.2) * 100,
      1,
    );

    gaps.push({
      keyword: rows[0]!.keyword,
      competitorDomains: domains,
      bestCompetitorPosition: round(bestPosition, 1),
      ourPosition: ourPosition === null ? null : round(ourPosition, 1),
      estimatedVolume: volume,
      competitorCount: domains.length,
      gapScore,
      gapType,
      reason:
        ourPosition === null
          ? `${domains.length} tracked competitor${domains.length === 1 ? '' : 's'} rank${domains.length === 1 ? 's' : ''} for ` +
            `"${rows[0]!.keyword}" (best position ${bestPosition.toFixed(0)}) and we do not appear at all.` +
            (volume ? ` Estimated ${volume.toLocaleString()} monthly searches.` : '')
          : `We rank ${ourPosition.toFixed(1)} for "${rows[0]!.keyword}" while ${domains.length} competitor${domains.length === 1 ? '' : 's'} ` +
            `sit${domains.length === 1 ? 's' : ''} at ${bestPosition.toFixed(0)}. The relevance exists — the page needs to be better.`,
    });
  }

  return gaps.sort((a, b) => b.gapScore - a.gapScore).slice(0, maxResults);
}

/** Per-competitor overview for the competitors table. */
export function buildCompetitorOverview(
  domain: string,
  ourKeywords: OurKeywordRow[],
  competitorRows: CompetitorKeywordRow[],
): CompetitorOverview {
  const theirs = competitorRows.filter((r) => r.competitorDomain === domain && r.position !== null);
  const ours = new Map<string, OurKeywordRow>();
  for (const row of ourKeywords) ours.set(normalizeKeyword(row.keyword), row);

  let shared = 0;
  let gap = 0;
  let wins = 0;
  let losses = 0;
  const positions: number[] = [];

  for (const row of theirs) {
    const key = normalizeKeyword(row.keyword);
    const ourRow = ours.get(key);
    positions.push(row.position ?? 100);
    if (ourRow && ourRow.position !== null) {
      shared++;
      if (ourRow.position < (row.position ?? 100)) wins++;
      else losses++;
    } else {
      gap++;
    }
  }

  // Topical strengths: the most common head terms among keywords where they beat us.
  const losingKeywords = theirs.filter((row) => {
    const ourRow = ours.get(normalizeKeyword(row.keyword));
    return !ourRow || ourRow.position === null || ourRow.position > (row.position ?? 100);
  });
  const termCounts = new Map<string, number>();
  for (const row of losingKeywords) {
    for (const token of new Set(normalizeKeyword(row.keyword).split(/\s+/).filter((t) => t.length > 3))) {
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }
  }
  const topicalStrengths = [...termCounts.entries()]
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([term]) => term);

  return {
    domain,
    sharedKeywords: shared,
    gapKeywords: gap,
    totalKeywords: theirs.length,
    avgPosition: positions.length ? round(positions.reduce((s, p) => s + p, 0) / positions.length, 1) : null,
    serpOverlapPct: ourKeywords.length ? round((shared / ourKeywords.length) * 100, 1) : 0,
    topicalStrengths,
    wins,
    losses,
  };
}

/**
 * Detect likely competitors from SERP snapshots: domains that repeatedly appear alongside us,
 * weighted by how well they rank. Only used when a SERP provider is configured.
 */
export function detectCompetitorsFromSerp(
  snapshots: Array<{ query: string; results: Array<{ position: number; url: string; domain: string }> }>,
  ourDomain: string,
  options: { minAppearances?: number; maxResults?: number } = {},
): Array<{ domain: string; appearances: number; avgPosition: number; queries: string[]; score: number }> {
  const minAppearances = options.minAppearances ?? 3;
  const maxResults = options.maxResults ?? 20;

  const stats = new Map<string, { appearances: number; positionSum: number; queries: Set<string> }>();
  const excluded = new Set([
    ourDomain.toLowerCase(),
    'google.com', 'youtube.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
    'linkedin.com', 'reddit.com', 'wikipedia.org', 'amazon.com', 'pinterest.com', 'quora.com',
    'medium.com', 'github.com', 'tiktok.com', 'apple.com', 'play.google.com',
  ]);

  for (const snapshot of snapshots) {
    for (const result of snapshot.results) {
      const domain = result.domain.toLowerCase().replace(/^www\./, '');
      if (excluded.has(domain) || domain.endsWith(`.${ourDomain}`) || domain === ourDomain) continue;
      const entry = stats.get(domain) ?? { appearances: 0, positionSum: 0, queries: new Set<string>() };
      entry.appearances++;
      entry.positionSum += result.position;
      entry.queries.add(snapshot.query);
      stats.set(domain, entry);
    }
  }

  return [...stats.entries()]
    .filter(([, entry]) => entry.appearances >= minAppearances)
    .map(([domain, entry]) => {
      const avgPosition = entry.positionSum / entry.appearances;
      return {
        domain,
        appearances: entry.appearances,
        avgPosition: round(avgPosition, 1),
        queries: [...entry.queries].slice(0, 10),
        // Frequent appearances at strong positions across many distinct queries = real competitor.
        score: round(
          (clamp(entry.appearances / Math.max(1, snapshots.length)) * 0.5 +
            clamp(1 - (avgPosition - 1) / 20) * 0.3 +
            clamp(entry.queries.size / Math.max(1, snapshots.length)) * 0.2) * 100,
          1,
        ),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
