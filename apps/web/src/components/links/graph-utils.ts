/**
 * Pure helpers shared by the internal-link and architecture screens.
 *
 * Deliberately free of imports from `@seo/*`: these run in the browser, and the shared barrel
 * pulls in server-only modules (env, crypto) that must never reach a client bundle.
 */

import type { GraphNodeDto } from './types';

/**
 * The site section a URL belongs to, taken from its first path segment.
 *
 * The link graph endpoint carries no topic-cluster assignment — clusters live on keywords, not
 * on the graph — so the honest grouping available here is the site's own URL structure. It is
 * labelled as such everywhere it is shown rather than being passed off as a topic cluster.
 */
export function sectionOf(url: string): string {
  try {
    const segment = new URL(url).pathname.split('/').filter(Boolean)[0];
    return segment === undefined ? '/ (root)' : `/${segment}`;
  } catch {
    return 'Unparseable URL';
  }
}

/** Authority is a normalised 0-1 PageRank; operators read a 0-100 index far more easily. */
export function authorityIndex(authority: number): number {
  return Math.round(authority * 100);
}

export interface AuthorityBand {
  id: string;
  label: string;
  min: number;
}

/**
 * Fixed bands rather than percentiles: a percentile band would relabel every page whenever the
 * sample size changed, so two visits to the same site could colour the same page differently.
 */
export const AUTHORITY_BANDS: readonly AuthorityBand[] = [
  { id: 'a5', label: 'Authority 60–100', min: 0.6 },
  { id: 'a4', label: 'Authority 30–59', min: 0.3 },
  { id: 'a3', label: 'Authority 10–29', min: 0.1 },
  { id: 'a2', label: 'Authority 3–9', min: 0.03 },
  { id: 'a1', label: 'Authority 0–2', min: 0 },
];

export function authorityBand(authority: number): string {
  for (const band of AUTHORITY_BANDS) {
    if (authority >= band.min) return band.label;
  }
  return AUTHORITY_BANDS[AUTHORITY_BANDS.length - 1]?.label ?? 'Authority 0–2';
}

export type GraphColorMode = 'section' | 'depth' | 'authority';

/**
 * `SiteGraph` derives a node's colour from `cluster` (hashed) or `depth`, and its own filter
 * dropdown filters on `cluster`. Feeding `cluster` the band that matches the chosen colour mode
 * keeps colour, hover card and filter describing the same thing instead of three different ones.
 */
export function clusterLabelFor(node: GraphNodeDto, mode: GraphColorMode): string {
  return mode === 'authority' ? authorityBand(node.authority) : sectionOf(node.url);
}

/** Counts per click-depth, ascending, for the depth distribution chart. */
export function depthHistogram(nodes: readonly GraphNodeDto[]): Array<{ depth: number; count: number }> {
  const counts = new Map<number, number>();
  for (const node of nodes) counts.set(node.depth, (counts.get(node.depth) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([depth, count]) => ({ depth, count }));
}

/** Escape a user-supplied string for use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SnippetPart {
  text: string;
  match: boolean;
}

/**
 * Split the placement sentence around the suggested anchor so the anchor can be marked up.
 * Returns a single non-matching part when the anchor is not literally present — the suggester
 * sometimes proposes a near-match phrasing, and inventing a highlight would misrepresent it.
 */
export function splitOnAnchor(snippet: string, anchor: string): SnippetPart[] {
  const needle = anchor.trim();
  if (needle.length === 0) return [{ text: snippet, match: false }];

  const pattern = new RegExp(`(${escapeRegExp(needle)})`, 'gi');
  const pieces = snippet.split(pattern).filter((piece) => piece.length > 0);
  if (pieces.length <= 1) return [{ text: snippet, match: false }];

  const lower = needle.toLowerCase();
  return pieces.map((text) => ({ text, match: text.toLowerCase() === lower }));
}
