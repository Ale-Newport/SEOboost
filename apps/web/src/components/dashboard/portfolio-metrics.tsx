import Link from 'next/link';
import { AlertTriangle, CheckSquare, FileWarning, Globe, MousePointerClick, Search, Target, TrendingUp } from 'lucide-react';
import { MetricCard } from '@/components/ui/metric-card';
import { formatCompact, formatNumber, formatPercent, formatPosition } from '@/lib/utils';
import type { DashboardData } from '@/server/queries/dashboard';

interface Props {
  performance: DashboardData['performance'];
  keywordCounts: DashboardData['keywordCounts'];
  counts: DashboardData['counts'];
  websites: DashboardData['websites'];
}

/**
 * The portfolio KPI row.
 * Every figure comes from imported Search Console data — when nothing is connected the cards show
 * "—" and a hint rather than a fabricated number.
 */
export function PortfolioMetrics({ performance, keywordCounts, counts, websites }: Props) {
  const totals = performance?.totals;
  const deltas = performance?.deltas;
  const hasTraffic = Boolean(performance?.hasData);
  const avgHealth =
    websites.filter((w) => w.healthScore !== null).length > 0
      ? websites.reduce((sum, w) => sum + (w.healthScore ?? 0), 0) /
        websites.filter((w) => w.healthScore !== null).length
      : null;

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <MetricCard
        label="Organic clicks"
        value={hasTraffic ? formatNumber(totals?.clicks) : '—'}
        delta={deltas?.clicks.changePct ?? null}
        icon={MousePointerClick}
        deltaLabel="vs the previous 28 days"
        footer={hasTraffic ? 'Last 28 days' : 'Connect Search Console to see traffic'}
      />
      <MetricCard
        label="Impressions"
        value={hasTraffic ? formatCompact(totals?.impressions) : '—'}
        delta={deltas?.impressions.changePct ?? null}
        icon={TrendingUp}
        deltaLabel="vs the previous 28 days"
        footer={hasTraffic ? 'Across every connected property' : 'Requires a Search Console connection'}
      />
      <MetricCard
        label="Avg. position"
        value={hasTraffic ? formatPosition(totals?.position) : '—'}
        delta={deltas?.position.changePct ?? null}
        invertDelta
        icon={Target}
        deltaLabel="vs the previous 28 days"
        info="Impression-weighted across every connected property. Lower is better."
      />
      <MetricCard
        label="Keywords in top 10"
        value={formatNumber(keywordCounts.top10)}
        icon={Search}
        footer={`${formatNumber(keywordCounts.top3)} in the top 3 · ${formatNumber(keywordCounts.top100)} in the top 100`}
      />
      <MetricCard
        label="Technical health"
        value={avgHealth === null ? '—' : `${Math.round(avgHealth)}/100`}
        icon={counts.criticalIssues > 0 ? AlertTriangle : Globe}
        info="Weighted by issue severity, rule weight and site size. Open the site audit for the full methodology."
        footer={
          counts.criticalIssues > 0
            ? `${formatNumber(counts.criticalIssues)} critical issue${counts.criticalIssues === 1 ? '' : 's'} across the portfolio`
            : `${formatNumber(counts.openIssues)} open issue${counts.openIssues === 1 ? '' : 's'}`
        }
      />
      <MetricCard
        label="Pending approvals"
        value={formatNumber(counts.pendingApprovals)}
        icon={counts.pendingApprovals > 0 ? CheckSquare : FileWarning}
        footer={
          counts.pendingApprovals > 0
            ? 'Changes waiting on your decision'
            : `${formatNumber(counts.actionsThisWeek)} action${counts.actionsThisWeek === 1 ? '' : 's'} completed this week`
        }
      />
    </div>
  );
}
