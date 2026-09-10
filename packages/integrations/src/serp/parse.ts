/**
 * Small parsing utilities shared by the SERP providers.
 *
 * Vendors label SERP elements differently (`featured_snippet` vs `answer_box` vs
 * `answerBox`). Collapsing them here means the scoring layer sees one vocabulary and a new
 * provider only has to add aliases.
 */

import { getHostname } from '@seo/shared';
import type { SerpResultType } from './types';

const TYPE_ALIASES: Record<string, SerpResultType> = {
  organic: 'organic',
  organic_results: 'organic',
  featured_snippet: 'featured_snippet',
  answer_box: 'featured_snippet',
  answerbox: 'featured_snippet',
  ai_overview: 'ai_overview',
  ai_overview_reference: 'ai_overview',
  generative_ai: 'ai_overview',
  local_pack: 'local_pack',
  local_results: 'local_pack',
  map: 'local_pack',
  google_maps: 'local_pack',
  video: 'video',
  videos: 'video',
  inline_videos: 'video',
  images: 'image',
  image: 'image',
  inline_images: 'image',
  news: 'news',
  top_stories: 'news',
  topstories: 'news',
  shopping: 'shopping',
  shopping_results: 'shopping',
  popular_products: 'shopping',
  knowledge_graph: 'knowledge_graph',
  knowledgegraph: 'knowledge_graph',
  discussions_and_forums: 'discussion',
  twitter: 'discussion',
  paid: 'paid',
  ads: 'paid',
  shopping_ads: 'paid',
};

/** Map a vendor's element label onto our vocabulary; unknown labels become `other`. */
export function mapResultType(raw: string): SerpResultType {
  return TYPE_ALIASES[raw.trim().toLowerCase()] ?? 'other';
}

/** Hostname of a SERP result URL, `www.`-stripped. Empty string when the URL is unusable. */
export function toDomain(url: string): string {
  return getHostname(url) ?? '';
}

/** Preserve order, drop blanks and case-insensitive duplicates. */
export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
