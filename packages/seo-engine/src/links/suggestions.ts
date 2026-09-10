import {
  clamp,
  containsPhrase,
  cosineSimilarity,
  lexicalCosine,
  normalizeKeyword,
  round,
  splitSentences,
  tokenize,
  truncate,
} from '@seo/shared';

export interface LinkCandidatePage {
  id: string;
  url: string;
  normalizedUrl: string;
  title: string | null;
  h1: string | null;
  metaDescription: string | null;
  textContent: string | null;
  wordCount: number;
  isIndexable: boolean;
  depth: number;
  /** Keywords this page is meant to rank for, best first. */
  targetKeywords: string[];
  /** Existing embedding, when the AI provider has produced one. */
  embedding?: number[] | null;
  inboundLinks: number;
  outboundLinks: number;
  clusterId?: string | null;
}

export interface ExistingLink {
  sourceId: string;
  targetId: string;
  anchorText: string;
}

export interface InternalLinkSuggestion {
  sourcePageId: string;
  sourceUrl: string;
  targetPageId: string;
  targetUrl: string;
  anchorText: string;
  placementHint: string;
  contextSnippet: string | null;
  reason: string;
  relevanceScore: number;
  impactScore: number;
}

export interface SuggestionOptions {
  /** Minimum semantic similarity to consider two pages related. */
  minRelevance?: number;
  /** Maximum suggestions produced per source page, so no page gets stuffed. */
  maxPerSourcePage?: number;
  /** Maximum suggestions produced per target page. */
  maxPerTargetPage?: number;
  /** Overall cap. */
  maxTotal?: number;
  /** Pages with at least this many inbound links are considered "well linked" already. */
  wellLinkedThreshold?: number;
}

/**
 * Suggest internal links from real page-to-page relationships.
 *
 * Strategy, in priority order:
 *   1. Under-linked and orphan pages first — they have the most to gain.
 *   2. Source pages must be *semantically related* (embeddings when available, lexical cosine
 *      otherwise) and must not already link to the target.
 *   3. The anchor must appear (or nearly appear) in the source's existing prose, so the link can
 *      be placed naturally rather than bolted on. We return the exact sentence as the placement.
 *   4. Anchor diversity: never suggest the same exact-match anchor more than twice for one target,
 *      which is how over-optimisation happens.
 */
export function suggestInternalLinks(
  pages: LinkCandidatePage[],
  existingLinks: ExistingLink[],
  options: SuggestionOptions = {},
): InternalLinkSuggestion[] {
  const minRelevance = options.minRelevance ?? 0.28;
  const maxPerSource = options.maxPerSourcePage ?? 3;
  const maxPerTarget = options.maxPerTargetPage ?? 5;
  const maxTotal = options.maxTotal ?? 500;
  const wellLinked = options.wellLinkedThreshold ?? 8;

  const linkedPairs = new Set(existingLinks.map((l) => `${l.sourceId}→${l.targetId}`));
  const anchorUsage = new Map<string, number>(); // `${targetId}|${anchor}` → count
  for (const link of existingLinks) {
    const key = `${link.targetId}|${normalizeKeyword(link.anchorText)}`;
    anchorUsage.set(key, (anchorUsage.get(key) ?? 0) + 1);
  }

  const eligible = pages.filter((p) => p.isIndexable && p.wordCount > 50);

  // Targets ordered by need: orphans first, then under-linked, then everything else.
  const targets = [...eligible].sort((a, b) => {
    const needA = a.inboundLinks === 0 ? 0 : a.inboundLinks;
    const needB = b.inboundLinks === 0 ? 0 : b.inboundLinks;
    return needA - needB;
  });

  const perSource = new Map<string, number>();
  const perTarget = new Map<string, number>();
  const suggestions: InternalLinkSuggestion[] = [];

  for (const target of targets) {
    if (suggestions.length >= maxTotal) break;
    if (target.inboundLinks >= wellLinked) continue;

    const targetTerms = collectTargetTerms(target);
    if (targetTerms.length === 0) continue;

    const scored: Array<{ source: LinkCandidatePage; relevance: number; anchor: string; sentence: string | null }> = [];

    for (const source of eligible) {
      if (source.id === target.id) continue;
      if (linkedPairs.has(`${source.id}→${target.id}`)) continue;
      if ((perSource.get(source.id) ?? 0) >= maxPerSource) continue;
      if (!source.textContent) continue;
      // A page already overloaded with outbound links should not receive more.
      if (source.outboundLinks > 150) continue;

      const relevance = pageSimilarity(source, target);
      if (relevance < minRelevance) continue;

      const match = findAnchorInText(source.textContent, targetTerms);
      if (!match) continue;

      const anchorKey = `${target.id}|${normalizeKeyword(match.anchor)}`;
      if ((anchorUsage.get(anchorKey) ?? 0) >= 2) continue; // anchor diversity guard

      scored.push({ source, relevance, anchor: match.anchor, sentence: match.sentence });
    }

    scored.sort((a, b) => b.relevance - a.relevance);

    for (const candidate of scored) {
      if (suggestions.length >= maxTotal) break;
      if ((perTarget.get(target.id) ?? 0) >= maxPerTarget) break;
      if ((perSource.get(candidate.source.id) ?? 0) >= maxPerSource) continue;

      const impact = linkImpact(target, candidate.relevance);
      const anchorKey = `${target.id}|${normalizeKeyword(candidate.anchor)}`;
      anchorUsage.set(anchorKey, (anchorUsage.get(anchorKey) ?? 0) + 1);
      perSource.set(candidate.source.id, (perSource.get(candidate.source.id) ?? 0) + 1);
      perTarget.set(target.id, (perTarget.get(target.id) ?? 0) + 1);
      linkedPairs.add(`${candidate.source.id}→${target.id}`);

      suggestions.push({
        sourcePageId: candidate.source.id,
        sourceUrl: candidate.source.url,
        targetPageId: target.id,
        targetUrl: target.url,
        anchorText: candidate.anchor,
        placementHint: candidate.sentence
          ? `Link the phrase "${candidate.anchor}" in: "${truncate(candidate.sentence, 160)}"`
          : `Add a contextual link using the anchor "${candidate.anchor}".`,
        contextSnippet: candidate.sentence,
        reason:
          target.inboundLinks === 0
            ? `${target.url} is an orphan page with no internal links. "${candidate.source.title ?? candidate.source.url}" already discusses this topic (${Math.round(candidate.relevance * 100)}% content similarity) and mentions "${candidate.anchor}".`
            : `${target.url} has only ${target.inboundLinks} inbound internal link(s). "${candidate.source.title ?? candidate.source.url}" is ${Math.round(candidate.relevance * 100)}% topically similar and already uses the phrase "${candidate.anchor}".`,
        relevanceScore: round(candidate.relevance, 3),
        impactScore: round(impact, 3),
      });
    }
  }

  return suggestions.sort((a, b) => b.impactScore - a.impactScore);
}

function collectTargetTerms(page: LinkCandidatePage): string[] {
  const terms = new Set<string>();
  for (const keyword of page.targetKeywords.slice(0, 8)) {
    const normalized = keyword.trim();
    if (normalized.length >= 4 && normalized.split(/\s+/).length <= 6) terms.add(normalized);
  }
  // The H1/title is usually the most natural anchor when no keyword is assigned.
  for (const candidate of [page.h1, page.title]) {
    if (!candidate) continue;
    const cleaned = candidate.split(/[|–—:]/)[0]?.trim();
    if (cleaned && cleaned.length >= 6 && cleaned.split(/\s+/).length <= 8) terms.add(cleaned);
  }
  return [...terms].sort((a, b) => b.length - a.length); // prefer the most specific phrase
}

function pageSimilarity(a: LinkCandidatePage, b: LinkCandidatePage): number {
  if (a.embedding?.length && b.embedding?.length && a.embedding.length === b.embedding.length) {
    // Embedding cosine sits in a narrow high band; rescale so thresholds stay meaningful.
    return clamp((cosineSimilarity(a.embedding, b.embedding) - 0.3) / 0.7);
  }
  const textA = `${a.title ?? ''} ${a.h1 ?? ''} ${a.metaDescription ?? ''} ${(a.textContent ?? '').slice(0, 4000)}`;
  const textB = `${b.title ?? ''} ${b.h1 ?? ''} ${b.metaDescription ?? ''} ${(b.textContent ?? '').slice(0, 4000)}`;
  let score = lexicalCosine(textA, textB);
  // Same cluster is strong evidence of relatedness even when wording differs.
  if (a.clusterId && a.clusterId === b.clusterId) score = clamp(score + 0.15);
  return score;
}

function linkImpact(target: LinkCandidatePage, relevance: number): number {
  // The first link into an orphan is worth far more than the ninth link into a hub page.
  const scarcity = target.inboundLinks === 0 ? 1 : clamp(1 / (1 + target.inboundLinks * 0.35));
  const depthFactor = target.depth >= 4 ? 1 : target.depth >= 2 ? 0.8 : 0.6;
  const substanceFactor = target.wordCount > 600 ? 1 : target.wordCount > 250 ? 0.8 : 0.5;
  return clamp(scarcity * 0.45 + relevance * 0.3 + depthFactor * 0.15 + substanceFactor * 0.1);
}

/** Find a phrase from `terms` inside `text` and return the sentence containing it. */
function findAnchorInText(text: string, terms: string[]): { anchor: string; sentence: string | null } | null {
  const sentences = splitSentences(text.slice(0, 20_000));
  for (const term of terms) {
    for (const sentence of sentences) {
      if (containsPhrase(sentence, term)) {
        // Recover the original casing from the sentence so the anchor reads naturally.
        const index = sentence.toLowerCase().indexOf(term.toLowerCase());
        const anchor = index >= 0 ? sentence.slice(index, index + term.length) : term;
        return { anchor, sentence };
      }
    }
  }
  // Fall back to a partial match on the most distinctive tokens of the best term.
  const best = terms[0];
  if (!best) return null;
  const bestTokens = tokenize(best).filter((t) => t.length > 4);
  if (bestTokens.length === 0) return null;
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const hits = bestTokens.filter((t) => lower.includes(t)).length;
    if (hits >= Math.max(1, Math.ceil(bestTokens.length * 0.7))) {
      return { anchor: best, sentence };
    }
  }
  return null;
}

export interface AnchorAudit {
  targetPageId: string;
  targetUrl: string;
  totalInbound: number;
  exactMatchCount: number;
  exactMatchRatio: number;
  topAnchors: Array<{ anchor: string; count: number }>;
  severity: 'high' | 'medium' | 'none';
  recommendation: string;
}

/**
 * Detect over-optimised anchor profiles: the same exact-match keyword used for most inbound
 * internal links reads as manipulation rather than natural editorial linking.
 */
export function auditAnchorText(
  pages: LinkCandidatePage[],
  existingLinks: ExistingLink[],
): AnchorAudit[] {
  const byTarget = new Map<string, ExistingLink[]>();
  for (const link of existingLinks) {
    const list = byTarget.get(link.targetId) ?? [];
    list.push(link);
    byTarget.set(link.targetId, list);
  }
  const pageById = new Map(pages.map((p) => [p.id, p]));

  const audits: AnchorAudit[] = [];
  for (const [targetId, links] of byTarget) {
    const page = pageById.get(targetId);
    if (!page || links.length < 5) continue;

    const counts = new Map<string, number>();
    for (const link of links) {
      const anchor = normalizeKeyword(link.anchorText);
      if (!anchor) continue;
      counts.set(anchor, (counts.get(anchor) ?? 0) + 1);
    }
    const targetKeywords = page.targetKeywords.map(normalizeKeyword);
    let exactMatchCount = 0;
    for (const [anchor, count] of counts) {
      if (targetKeywords.includes(anchor)) exactMatchCount += count;
    }
    const ratio = links.length ? exactMatchCount / links.length : 0;
    const severity = ratio >= 0.7 ? 'high' : ratio >= 0.45 ? 'medium' : 'none';
    if (severity === 'none') continue;

    audits.push({
      targetPageId: targetId,
      targetUrl: page.url,
      totalInbound: links.length,
      exactMatchCount,
      exactMatchRatio: round(ratio, 3),
      topAnchors: [...counts.entries()]
        .map(([anchor, count]) => ({ anchor, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      severity,
      recommendation:
        `${Math.round(ratio * 100)}% of the ${links.length} internal links to this page use the exact target keyword as anchor text. ` +
        'Vary the anchors with natural phrasing, partial matches and branded variations so the profile reads editorially.',
    });
  }
  return audits.sort((a, b) => b.exactMatchRatio - a.exactMatchRatio);
}
