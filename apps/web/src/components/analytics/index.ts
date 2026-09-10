/**
 * The search-performance explorer. Screens import from here rather than from the individual
 * files, so a component can be split or renamed without touching every call site.
 */

export { AnalyticsView } from './analytics-view';
export type { AnalyticsViewProps } from './analytics-view';

export { PerformanceToolbar } from './performance-toolbar';
export type { PerformanceToolbarProps } from './performance-toolbar';

export { PerformanceChart } from './performance-chart';
export type { PerformanceChartProps } from './performance-chart';

export { QueriesTable } from './queries-table';
export type { QueriesTableProps } from './queries-table';

export { PagesTable } from './pages-table';
export type { PagesTableProps } from './pages-table';

export { CtrGapTable } from './ctr-gap-table';
export type { CtrGapTableProps } from './ctr-gap-table';

export { SegmentBreakdown } from './segment-breakdown';
export type { SegmentBreakdownProps } from './segment-breakdown';

export { SearchConsoleEmptyState } from './search-console-empty-state';
export type { SearchConsoleEmptyStateProps } from './search-console-empty-state';

export { SyncSearchConsoleButton } from './sync-search-console-button';
export type { SyncSearchConsoleButtonProps } from './sync-search-console-button';

export { metricColumns } from './metric-columns';
export type { MetricAccessors } from './metric-columns';

export * from './types';
