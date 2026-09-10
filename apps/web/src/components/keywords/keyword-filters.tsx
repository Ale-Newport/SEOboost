'use client';

import { BadgeCheck, Compass, FileSearch, GitFork, Layers, Radar, Split } from 'lucide-react';
import {
  BooleanFilter,
  EnumFilter,
  FacetFilter,
  FilterBar,
  humanizeFilterValue,
  type FacetOption,
  type FilterLabelConfig,
} from '@/components/data/filter-bar';
import { formatNumber } from '@/lib/utils';
import type { KeywordFacets } from '@/server/queries/keywords';
import { POSITION_BANDS, POSITION_BAND_LIST, isPositionBandId } from './position-bands';

/**
 * Filters are URL state end to end: every control writes a param, the server reads the same
 * param, and the counts beside each option are real facet counts rather than client-side guesses.
 */

const UNCLUSTERED_VALUE = 'none';

/** Labels for the removable pills in the table toolbar. */
export const KEYWORD_FILTER_LABELS: Readonly<Record<string, FilterLabelConfig>> = {
  intent: { label: 'Intent', formatValue: humanizeFilterValue },
  funnelStage: { label: 'Funnel stage', formatValue: humanizeFilterValue },
  source: { label: 'Source', formatValue: humanizeFilterValue },
  band: {
    label: 'Position',
    formatValue: (value) => (isPositionBandId(value) ? POSITION_BANDS[value].label : value),
  },
  clusterId: { label: 'Cluster', formatValue: (value) => (value === UNCLUSTERED_VALUE ? 'Unclustered' : value) },
  contentGap: { label: 'Content gap', formatValue: () => 'Yes' },
  branded: { label: 'Branded', formatValue: () => 'Yes' },
  tracked: { label: 'Tracked', formatValue: () => 'Yes' },
  cannibalization: { label: 'Cannibalised', formatValue: () => 'Yes' },
};

function toOptions(entries: ReadonlyArray<{ value: string; count: number }>): FacetOption[] {
  return entries.map((entry) => ({ value: entry.value, label: humanizeFilterValue(entry.value), count: entry.count }));
}

export function KeywordFilters({ facets }: { facets: KeywordFacets }): React.JSX.Element {
  const bandOptions: FacetOption[] = POSITION_BAND_LIST.map((band) => {
    const count =
      band.facetBucket === undefined
        ? undefined
        : facets.positionBuckets.find((entry) => entry.bucket === band.facetBucket)?.count;
    return count === undefined ? { value: band.id, label: band.label } : { value: band.id, label: band.label, count };
  });

  const clusterOptions: FacetOption[] = [
    ...(facets.unclustered > 0
      ? [{ value: UNCLUSTERED_VALUE, label: 'Unclustered', count: facets.unclustered }]
      : []),
    ...facets.clusters.map((cluster) => ({
      value: cluster.id,
      label: cluster.name,
      count: cluster.keywordCount,
    })),
  ];

  return (
    <FilterBar>
      <FacetFilter paramKey="intent" label="Intent" icon={Compass} options={toOptions(facets.intent)} />
      <FacetFilter paramKey="funnelStage" label="Funnel" icon={GitFork} options={toOptions(facets.funnelStage)} />
      <FacetFilter paramKey="source" label="Source" icon={Radar} options={toOptions(facets.source)} searchable />
      <EnumFilter paramKey="band" label="Position" options={bandOptions} allLabel="Any position" />
      {clusterOptions.length > 0 ? (
        <EnumFilter
          paramKey="clusterId"
          label="Cluster"
          options={clusterOptions}
          allLabel={`All clusters (${formatNumber(facets.clusters.length)})`}
        />
      ) : null}
      <BooleanFilter paramKey="contentGap" label="Content gap" icon={FileSearch} />
      <BooleanFilter paramKey="cannibalization" label="Cannibalised" icon={Split} />
      <BooleanFilter paramKey="branded" label="Branded" icon={BadgeCheck} />
      <BooleanFilter paramKey="tracked" label="Tracked" icon={Layers} />
    </FilterBar>
  );
}
