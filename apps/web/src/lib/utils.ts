import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const numberFormatter = new Intl.NumberFormat('en-US');
const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatNumber(value: number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return numberFormatter.format(Math.round(value));
}

export function formatCompact(value: number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return compactFormatter.format(value);
}

export function formatPercent(value: number | null | undefined, decimals = 1, fallback = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatDelta(value: number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(decimals)}%`;
}

export function formatPosition(value: number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  return value.toFixed(1);
}

export function formatUsd(value: number | null | undefined, fallback = '$0.00'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return fallback;
  if (value > 0 && value < 0.01) return '<$0.01';
  return `$${value.toFixed(value >= 100 ? 0 : 2)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Shorten a URL for dense tables: strips protocol + host, keeps the path. */
export function shortenUrl(url: string, maxLength = 48): string {
  let display = url;
  try {
    const u = new URL(url);
    display = u.pathname === '/' ? '/' : `${u.pathname}${u.search}`;
  } catch {
    /* keep raw */
  }
  if (display.length <= maxLength) return display;
  return `${display.slice(0, maxLength - 1)}…`;
}

export function initials(text: string): string {
  return text
    .split(/[\s.-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** Deterministic colour index for a label (charts, avatars) — no randomness across renders. */
export function colorIndex(label: string, buckets = 6): number {
  let hash = 0;
  for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) | 0;
  return Math.abs(hash) % buckets;
}
