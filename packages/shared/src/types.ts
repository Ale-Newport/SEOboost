/** Cross-package domain types that are not Prisma models. */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface ScoreFactor {
  key: string;
  label: string;
  /** Raw contribution before weighting, 0-1. */
  value: number;
  weight: number;
  /** value × weight × 100 */
  contribution: number;
  explanation: string;
}

export interface ExplainableScore {
  score: number;
  factors: ScoreFactor[];
  summary: string;
}

export interface IntegrationHealth {
  provider: string;
  label: string;
  status: 'CONNECTED' | 'NOT_CONFIGURED' | 'ERROR' | 'EXPIRED' | 'DISABLED';
  detail?: string;
  lastSyncAt?: string | null;
  /** Env vars the operator must set to enable this integration. */
  requiredEnv?: string[];
}

export interface MetricDelta {
  current: number;
  previous: number;
  change: number;
  changePct: number | null;
}

export interface TimeSeriesPoint {
  date: string;
  [metric: string]: string | number | null;
}

export type Trend = 'up' | 'down' | 'flat';

export interface HeadingNode {
  level: number;
  text: string;
}

export interface StructuredDataBlock {
  type: string[];
  raw: unknown;
  valid: boolean;
  errors?: string[];
}

export interface ImageInfo {
  src: string;
  alt: string | null;
  width?: number | null;
  height?: number | null;
  loading?: string | null;
}

export interface DiscoveredLink {
  href: string;
  normalized: string;
  anchorText: string;
  rel: string | null;
  isInternal: boolean;
  isNofollow: boolean;
  inNav: boolean;
  inFooter: boolean;
  inMainContent: boolean;
  position: number;
}

export interface JobProgress {
  processed: number;
  total: number;
  message?: string;
}
