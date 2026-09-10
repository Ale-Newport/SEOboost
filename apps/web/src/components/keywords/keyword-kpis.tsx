'use client';

import { FileSearch, KeyRound, Layers, Target, Trophy } from 'lucide-react';
import { MetricCard } from '@/components/ui/metric-card';
import { formatNumber, formatPercent } from '@/lib/utils';
import type { KeywordFacets } from '@/server/queries/keywords';

/**
 * The five numbers that decide what someone does on this screen: how much there is, how much of
 * it already wins, how much is one push away, and how much has no page behind it at all.
 *
 * Every figure is a real count from `getKeywordFacets` — including the zeros, which are the
 * honest answer for a site with no Search Console connection.
 */
export function KeywordKpis({ facets }: { facets: KeywordFacets }): React.JSX.Element {
  const bucket = (id: string): number => facets.positionBuckets.find((entry) => entry.bucket === id)?.count ?? 0;

  const top3 = bucket('1-3');
  const top10 = top3 + bucket('4-10');
  const strikingDistance = bucket('11-20');
  const ranked = top10 + strikingDistance + bucket('21-50') + bucket('51-100');

  const share = (value: number): string =>
    facets.total > 0 ? `${formatPercent(value / facets.total, 1)} of all keywords` : 'No keywords yet';

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <MetricCard
        label="Keywords"
        value={formatNumber(facets.total)}
        icon={KeyRound}
        footer={
          facets.total === 0
            ? 'Nothing imported or discovered yet'
            : `${formatNumber(facets.tracked)} tracked · ${formatNumber(ranked)} ranking`
        }
      />
      <MetricCard
        label="Top 3"
        value={formatNumber(top3)}
        icon={Trophy}
        footer={share(top3)}
        info="Keywords whose latest recorded position is 1–3. Positions come from Search Console or a SERP provider — never estimated."
      />
      <MetricCard
        label="Top 10"
        value={formatNumber(top10)}
        icon={Target}
        footer={share(top10)}
        info="Positions 1–10: the queries where this site is already on page one."
      />
      <MetricCard
        label="Striking distance"
        value={formatNumber(strikingDistance)}
        icon={Layers}
        footer="Positions 11 – 20"
        info="Ranking on page two. Close enough that focused on-page work — better matching content, internal links, a stronger title — can realistically reach page one."
      />
      <MetricCard
        label="Content gaps"
        value={formatNumber(facets.contentGaps)}
        icon={FileSearch}
        footer={
          facets.cannibalized > 0
            ? `${formatNumber(facets.cannibalized)} also cannibalised`
            : 'No page targets these well'
        }
        info="Keywords the analysis found no well-matched page for. These are the candidates for new content rather than optimisation."
      />
    </div>
  );
}
