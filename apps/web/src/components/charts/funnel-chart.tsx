'use client';

import { useMemo } from 'react';
import { ChartContainer, seriesColor, useChartColors, withAlpha } from './chart-container';
import { cn, formatNumber } from '@/lib/utils';

export interface FunnelStage {
  id: string;
  label: string;
  value: number;
  color?: string;
  colorIndex?: number;
}

export interface FunnelChartProps {
  stages: readonly FunnelStage[];
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  loading?: boolean;
  emptyMessage?: string;
  /** Show each stage's share of the previous stage. */
  showConversion?: boolean;
  /** Show each stage's share of the first stage instead of the previous one. */
  conversionBase?: 'previous' | 'first';
  unitLabel?: string;
  onStageClick?: (id: string) => void;
  rowHeight?: number;
  bare?: boolean;
  className?: string;
}

/**
 * Horizontal funnel for pipeline stage counts (briefs → drafts → review → published).
 *
 * Bars are scaled against the largest stage rather than the first one, so a pipeline that
 * legitimately grows in the middle still renders sensibly.
 */
export function FunnelChart({
  stages,
  title,
  description,
  actions,
  loading = false,
  emptyMessage = 'Nothing in the pipeline yet.',
  showConversion = true,
  conversionBase = 'previous',
  unitLabel = 'items',
  onStageClick,
  rowHeight = 44,
  bare = false,
  className,
}: FunnelChartProps) {
  const colors = useChartColors();

  const rows = useMemo(
    () =>
      stages.map((s, i) => ({
        ...s,
        value: Math.max(0, s.value),
        color: s.color ?? seriesColor(colors, s.colorIndex ?? i),
      })),
    [stages, colors],
  );

  const max = rows.reduce((acc, s) => Math.max(acc, s.value), 0);
  const total = rows.reduce((acc, s) => acc + s.value, 0);
  const firstValue = rows[0]?.value ?? 0;

  const ariaLabel = useMemo(() => {
    if (rows.length === 0 || total === 0) return `Funnel chart with no ${unitLabel}`;
    return `Funnel of ${unitLabel}: ${rows.map((s) => `${s.label} ${formatNumber(s.value)}`).join(', then ')}.`;
  }, [rows, total, unitLabel]);

  const height = Math.max(rowHeight, rows.length * rowHeight);

  return (
    <ChartContainer
      title={title}
      description={description}
      actions={actions}
      loading={loading}
      empty={rows.length === 0 || total === 0}
      emptyMessage={emptyMessage}
      height={height}
      bare={bare}
      className={className}
      bodyClassName={bare ? undefined : 'px-4 pb-4'}
    >
      <ol className="flex h-full flex-col justify-between gap-1" role="img" aria-label={ariaLabel}>
        {rows.map((stage, i) => {
          const widthPct = max > 0 ? Math.max(2, (stage.value / max) * 100) : 0;
          const base = conversionBase === 'first' ? firstValue : (rows[i - 1]?.value ?? 0);
          const conversion = i > 0 && base > 0 ? (stage.value / base) * 100 : null;

          const content = (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-xs font-medium">{stage.label}</span>
                <span className="flex shrink-0 items-baseline gap-2">
                  <span className="tabular text-xs font-semibold">{formatNumber(stage.value)}</span>
                  {showConversion && conversion !== null ? (
                    <span className="tabular text-2xs text-muted-foreground">
                      {conversion.toFixed(0)}%
                    </span>
                  ) : null}
                </span>
              </div>
              <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full transition-[width] duration-300"
                  style={{
                    width: `${widthPct}%`,
                    backgroundColor: stage.color,
                    boxShadow: `inset 0 0 0 1px ${withAlpha(stage.color, 0.35)}`,
                  }}
                />
              </div>
            </>
          );

          return (
            <li key={stage.id} className="min-w-0">
              {onStageClick ? (
                <button
                  type="button"
                  onClick={() => onStageClick(stage.id)}
                  className={cn(
                    'w-full rounded-sm px-1 py-1 text-left transition-colors hover:bg-muted/50',
                  )}
                  aria-label={`${stage.label}: ${formatNumber(stage.value)} ${unitLabel}`}
                >
                  {content}
                </button>
              ) : (
                <div className="px-1 py-1">{content}</div>
              )}
            </li>
          );
        })}
      </ol>
    </ChartContainer>
  );
}
