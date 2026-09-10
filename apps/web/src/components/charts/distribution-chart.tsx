'use client';

import { useMemo } from 'react';
import { ChartContainer, seriesColor, useChartColors, type ChartColors } from './chart-container';
import { cn, formatNumber } from '@/lib/utils';

/** The ranking buckets every screen in the app reports against. Order matters — best first. */
export const RANK_BUCKETS = [
  { id: 'pos1to3', label: '1–3', min: 1, max: 3 },
  { id: 'pos4to10', label: '4–10', min: 4, max: 10 },
  { id: 'pos11to20', label: '11–20', min: 11, max: 20 },
  { id: 'pos21to50', label: '21–50', min: 21, max: 50 },
  { id: 'pos51to100', label: '51–100', min: 51, max: 100 },
] as const;

export type RankBucketId = (typeof RANK_BUCKETS)[number]['id'];

/** Good-to-bad ramp; resolved from tokens so it flips correctly in dark mode. */
function rankBucketColor(colors: ChartColors, id: RankBucketId): string {
  switch (id) {
    case 'pos1to3':
      return colors.success;
    case 'pos4to10':
      return seriesColor(colors, 0);
    case 'pos11to20':
      return seriesColor(colors, 4);
    case 'pos21to50':
      return colors.warning;
    case 'pos51to100':
    default:
      return colors.mutedForeground;
  }
}

/**
 * Count positions into the standard buckets. Positions outside 1-100 (and non-finite values,
 * which is how "not ranking" arrives from providers) are excluded rather than clamped, so the
 * chart never implies a ranking that does not exist.
 */
export function bucketPositions(
  positions: ReadonlyArray<number | null | undefined>,
): Record<RankBucketId, number> {
  const counts = {
    pos1to3: 0,
    pos4to10: 0,
    pos11to20: 0,
    pos21to50: 0,
    pos51to100: 0,
  } satisfies Record<RankBucketId, number>;

  for (const raw of positions) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const p = Math.round(raw);
    const bucket = RANK_BUCKETS.find((b) => p >= b.min && p <= b.max);
    if (bucket) counts[bucket.id] += 1;
  }
  return counts;
}

export interface DistributionSegment {
  id: string;
  label: string;
  count: number;
  color?: string;
  colorIndex?: number;
}

export interface DistributionChartProps {
  /** Explicit segments; takes precedence over `counts`. */
  segments?: readonly DistributionSegment[];
  /** Shortcut for the standard ranking buckets. */
  counts?: Partial<Record<RankBucketId, number>>;
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  loading?: boolean;
  emptyMessage?: string;
  showPercentages?: boolean;
  barHeight?: number;
  onSegmentClick?: (id: string) => void;
  /** Marks the currently filtered segment. */
  activeId?: string | null;
  unitLabel?: string;
  bare?: boolean;
  className?: string;
  height?: number;
}

/** Ranking distribution as a single horizontal stacked bar plus a legend with counts and shares. */
export function DistributionChart({
  segments,
  counts,
  title,
  description,
  actions,
  loading = false,
  emptyMessage = 'No ranked keywords in this period.',
  showPercentages = true,
  barHeight = 16,
  onSegmentClick,
  activeId = null,
  unitLabel = 'keywords',
  bare = false,
  className,
  height = 116,
}: DistributionChartProps) {
  const colors = useChartColors();

  const resolved = useMemo<DistributionSegment[]>(() => {
    if (segments) {
      return segments.map((s, i) => ({
        ...s,
        color: s.color ?? seriesColor(colors, s.colorIndex ?? i),
      }));
    }
    if (!counts) return [];
    return RANK_BUCKETS.map((b) => ({
      id: b.id,
      label: b.label,
      count: counts[b.id] ?? 0,
      color: rankBucketColor(colors, b.id),
    }));
  }, [segments, counts, colors]);

  const total = resolved.reduce((acc, s) => acc + Math.max(0, s.count), 0);

  const ariaLabel = useMemo(() => {
    if (total === 0) return `Distribution chart with no ${unitLabel}`;
    return `Distribution of ${formatNumber(total)} ${unitLabel}: ${resolved
      .map((s) => `${s.label}, ${formatNumber(s.count)}`)
      .join('; ')}.`;
  }, [resolved, total, unitLabel]);

  return (
    <ChartContainer
      title={title}
      description={description}
      actions={actions}
      loading={loading}
      empty={total === 0}
      emptyMessage={emptyMessage}
      height={height}
      bare={bare}
      className={className}
      bodyClassName={bare ? undefined : 'px-4 pb-4'}
    >
      <div className="flex h-full flex-col justify-center gap-3" role="img" aria-label={ariaLabel}>
        <div
          className="flex w-full overflow-hidden rounded-full bg-muted"
          style={{ height: barHeight }}
        >
          {resolved.map((s) => {
            const pct = total > 0 ? (s.count / total) * 100 : 0;
            if (pct <= 0) return null;
            const titleText = `${s.label}: ${formatNumber(s.count)} ${unitLabel} (${pct.toFixed(1)}%)`;
            const style = { width: `${pct}%`, backgroundColor: s.color };
            return onSegmentClick ? (
              <button
                key={s.id}
                type="button"
                title={titleText}
                aria-label={titleText}
                onClick={() => onSegmentClick(s.id)}
                style={style}
                className={cn(
                  'h-full transition-opacity hover:opacity-80',
                  activeId && activeId !== s.id && 'opacity-45',
                )}
              />
            ) : (
              <div
                key={s.id}
                title={titleText}
                style={style}
                className={cn('h-full', activeId && activeId !== s.id && 'opacity-45')}
              />
            );
          })}
        </div>

        <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {resolved.map((s) => {
            const pct = total > 0 ? (s.count / total) * 100 : 0;
            return (
              <li key={s.id} className="flex items-center gap-1.5 text-xs">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-muted-foreground">{s.label}</span>
                <span className="tabular font-medium">{formatNumber(s.count)}</span>
                {showPercentages ? (
                  <span className="tabular text-2xs text-muted-foreground">{pct.toFixed(0)}%</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </ChartContainer>
  );
}
