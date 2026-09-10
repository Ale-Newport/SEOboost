'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

/**
 * Palette resolved from the design tokens in globals.css.
 *
 * Every value is a full CSS colour string (`hsl(243 75% 59%)`) so it can be handed straight to
 * recharts, which writes it into SVG presentation attributes. Before the first effect runs — and
 * during SSR — the values are `hsl(var(--chart-1))` style references instead of literals, so the
 * very first painted frame is already theme-correct and nothing is hard-coded here.
 */
export interface ChartColors {
  /** --chart-1 … --chart-6, in order. Index with `colorIndex(label)` for stable per-label colours. */
  series: readonly string[];
  border: string;
  grid: string;
  muted: string;
  mutedForeground: string;
  foreground: string;
  background: string;
  card: string;
  popover: string;
  primary: string;
  success: string;
  warning: string;
  destructive: string;
  info: string;
}

const SERIES_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6'] as const;

const ROLE_VARS = {
  border: '--border',
  grid: '--border',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  foreground: '--foreground',
  background: '--background',
  card: '--card',
  popover: '--popover',
  primary: '--primary',
  success: '--success',
  warning: '--warning',
  destructive: '--destructive',
  info: '--info',
} as const;

type RoleKey = keyof typeof ROLE_VARS;

function varRef(name: string): string {
  return `hsl(var(${name}))`;
}

const FALLBACK_COLORS: ChartColors = {
  series: SERIES_VARS.map(varRef),
  border: varRef(ROLE_VARS.border),
  grid: varRef(ROLE_VARS.grid),
  muted: varRef(ROLE_VARS.muted),
  mutedForeground: varRef(ROLE_VARS.mutedForeground),
  foreground: varRef(ROLE_VARS.foreground),
  background: varRef(ROLE_VARS.background),
  card: varRef(ROLE_VARS.card),
  popover: varRef(ROLE_VARS.popover),
  primary: varRef(ROLE_VARS.primary),
  success: varRef(ROLE_VARS.success),
  warning: varRef(ROLE_VARS.warning),
  destructive: varRef(ROLE_VARS.destructive),
  info: varRef(ROLE_VARS.info),
};

function readResolvedColors(): ChartColors {
  if (typeof window === 'undefined' || typeof document === 'undefined') return FALLBACK_COLORS;
  const styles = window.getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const raw = styles.getPropertyValue(name).trim();
    return raw ? `hsl(${raw})` : fallback;
  };
  const roles = {} as Record<RoleKey, string>;
  for (const key of Object.keys(ROLE_VARS) as RoleKey[]) {
    roles[key] = read(ROLE_VARS[key], FALLBACK_COLORS[key]);
  }
  return {
    series: SERIES_VARS.map((name, i) => read(name, FALLBACK_COLORS.series[i] ?? varRef(name))),
    ...roles,
  };
}

/** Cheap structural comparison — avoids setState (and therefore a chart remount) on no-op reads. */
function sameColors(a: ChartColors, b: ChartColors): boolean {
  if (a.series.length !== b.series.length) return false;
  for (let i = 0; i < a.series.length; i++) if (a.series[i] !== b.series[i]) return false;
  return (Object.keys(ROLE_VARS) as RoleKey[]).every((k) => a[k] === b[k]);
}

/** useLayoutEffect warns during SSR; effects never run there anyway, so fall back to useEffect. */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Resolve the chart palette from the live computed style and keep it in sync with theme changes.
 *
 * next-themes swaps the `.dark` class on <html>, which does not remount anything, so a
 * MutationObserver on the root element is what makes charts follow the theme. The
 * prefers-color-scheme listener covers the "system" setting changing under us.
 */
export function useChartColors(): ChartColors {
  const [colors, setColors] = useState<ChartColors>(FALLBACK_COLORS);
  const frame = useRef<number | null>(null);

  // Resolve before the first paint so canvas-based charts (which cannot parse `var()`) never
  // see an unresolved value, and nothing flashes an unstyled frame.
  useIsomorphicLayoutEffect(() => {
    const next = readResolvedColors();
    setColors((prev) => (sameColors(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    const root = document.documentElement;

    const sync = (): void => {
      // Read on the next frame so we observe the styles *after* the class swap has been applied.
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        const next = readResolvedColors();
        setColors((prev) => (sameColors(prev, next) ? prev : next));
      });
    };

    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', sync);

    return () => {
      observer.disconnect();
      media.removeEventListener('change', sync);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, []);

  return colors;
}

/**
 * Add an alpha channel to a colour produced by `useChartColors`.
 * Works for both resolved (`hsl(243 75% 59%)`) and unresolved (`hsl(var(--chart-1))`) forms.
 */
export function withAlpha(color: string, alpha: number): string {
  const match = /^hsl\((.*)\)$/i.exec(color.trim());
  if (!match) return color;
  return `hsl(${match[1]} / ${alpha})`;
}

/** Pick a series colour by index, wrapping around the six-colour palette. */
export function seriesColor(colors: ChartColors, index: number): string {
  const palette = colors.series;
  if (palette.length === 0) return colors.primary;
  return palette[((index % palette.length) + palette.length) % palette.length] ?? colors.primary;
}

export interface ChartContainerProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Right-aligned controls: date range, metric toggles, export. */
  actions?: ReactNode;
  /** Rendered under the plot area — legends, footnotes, methodology links. */
  footer?: ReactNode;
  loading?: boolean;
  /** Render the empty state instead of the children. Charts must never draw a bare axis. */
  empty?: boolean;
  emptyTitle?: string;
  emptyMessage?: string;
  emptyIcon?: ReactNode;
  emptyAction?: ReactNode;
  /** Fixed plot height. Set on both the skeleton and the chart so loading causes no layout shift. */
  height?: number;
  /** Drop the card chrome when the chart is already inside a card. */
  bare?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * Shared frame for every chart: header, actions, fixed-height body, loading skeleton and
 * empty state. The body height never changes between the three states, so a chart that
 * finishes loading does not push the page around.
 */
export function ChartContainer({
  title,
  description,
  actions,
  footer,
  loading = false,
  empty = false,
  emptyTitle = 'No data yet',
  emptyMessage = 'There is nothing to plot for this period.',
  emptyIcon,
  emptyAction,
  height = 280,
  bare = false,
  className,
  bodyClassName,
  children,
}: ChartContainerProps) {
  const hasHeader = Boolean(title ?? description ?? actions);

  return (
    <section
      className={cn(
        !bare && 'rounded-lg border border-border bg-card text-card-foreground shadow-card',
        className,
      )}
    >
      {hasHeader ? (
        <header
          className={cn(
            'flex flex-wrap items-start justify-between gap-3',
            bare ? 'pb-3' : 'px-4 pb-3 pt-4',
          )}
        >
          <div className="min-w-0 space-y-0.5">
            {title ? <h3 className="truncate text-sm font-semibold tracking-tight">{title}</h3> : null}
            {description ? (
              <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}

      <div
        className={cn('relative', !bare && 'px-2 pb-3', bare && 'pb-0', bodyClassName)}
        style={{ minHeight: height }}
      >
        {loading ? (
          <ChartSkeleton height={height} />
        ) : empty ? (
          <ChartEmpty
            height={height}
            title={emptyTitle}
            message={emptyMessage}
            icon={emptyIcon}
            action={emptyAction}
          />
        ) : (
          <div style={{ height }}>{children}</div>
        )}
      </div>

      {footer ? (
        <div className={cn('border-t border-border/60 text-xs text-muted-foreground', bare ? 'pt-3' : 'px-4 py-3')}>
          {footer}
        </div>
      ) : null}
    </section>
  );
}

/** Bar-shaped shimmer that occupies exactly the plot height so nothing reflows on load. */
export function ChartSkeleton({ height = 280, bars = 12 }: { height?: number; bars?: number }) {
  // Deterministic staircase heights: a fixed pattern, never random, so SSR and client agree.
  const pattern = useMemo(
    () => Array.from({ length: bars }, (_, i) => 34 + ((i * 37) % 58)),
    [bars],
  );
  return (
    <div className="flex items-end gap-1.5 px-2" style={{ height }} aria-hidden="true">
      {pattern.map((pct, i) => (
        <div key={i} className="skeleton flex-1 rounded-sm" style={{ height: `${pct}%` }} />
      ))}
    </div>
  );
}

export function ChartEmpty({
  height = 280,
  title = 'No data yet',
  message,
  icon,
  action,
}: {
  height?: number;
  title?: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 px-6 text-center"
      style={{ height }}
      role="status"
    >
      {icon ? <div className="text-muted-foreground/70">{icon}</div> : null}
      <p className="text-sm font-medium text-foreground/80">{title}</p>
      {message ? <p className="max-w-sm text-xs text-muted-foreground">{message}</p> : null}
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

export interface ChartLegendItem {
  id: string;
  label: string;
  color: string;
  /** Dashed swatch — used for comparison-period series. */
  dashed?: boolean;
  value?: ReactNode;
  hidden?: boolean;
}

/** Clickable legend used by the multi-series charts to toggle series visibility. */
export function ChartLegend({
  items,
  onToggle,
  className,
}: {
  items: ChartLegendItem[];
  onToggle?: (id: string) => void;
  className?: string;
}) {
  const handle = useCallback((id: string) => () => onToggle?.(id), [onToggle]);

  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {items.map((item) => {
        const swatch = (
          <>
            <span
              aria-hidden="true"
              className={cn('inline-block h-0.5 w-3 shrink-0 rounded-full', item.dashed && 'opacity-70')}
              style={
                item.dashed
                  ? {
                      backgroundImage: `repeating-linear-gradient(90deg, ${item.color} 0 3px, transparent 3px 6px)`,
                    }
                  : { backgroundColor: item.color }
              }
            />
            <span className="truncate">{item.label}</span>
            {item.value !== undefined ? (
              <span className="tabular text-foreground/80">{item.value}</span>
            ) : null}
          </>
        );

        return (
          <li key={item.id} className="min-w-0">
            {onToggle ? (
              <button
                type="button"
                onClick={handle(item.id)}
                aria-pressed={!item.hidden}
                className={cn(
                  'flex min-w-0 items-center gap-1.5 rounded-sm px-1 py-0.5 text-xs text-muted-foreground transition-opacity hover:text-foreground',
                  item.hidden && 'opacity-40',
                )}
              >
                {swatch}
              </button>
            ) : (
              <span
                className={cn(
                  'flex min-w-0 items-center gap-1.5 px-1 py-0.5 text-xs text-muted-foreground',
                  item.hidden && 'opacity-40',
                )}
              >
                {swatch}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
