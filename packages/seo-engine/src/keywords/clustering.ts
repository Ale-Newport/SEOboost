import { cosineSimilarity, jaccardSimilarity, normalizeKeyword, round, slugify, tokenize } from '@seo/shared';

export interface ClusterableKeyword {
  id: string;
  keyword: string;
  normalized: string;
  impressions: number;
  clicks: number;
  searchVolume: number | null;
  position: number | null;
  intent: string;
  rankingUrl: string | null;
  embedding?: number[] | null;
}

export interface KeywordClusterResult {
  slug: string;
  name: string;
  keywordIds: string[];
  keywords: string[];
  parentTopic: string | null;
  intent: string;
  totalImpressions: number;
  totalClicks: number;
  totalVolume: number;
  avgPosition: number | null;
  centroid: number[];
  /** The URL that already ranks for most of this cluster, if any. */
  dominantUrl: string | null;
  urlSpread: number;
}

export interface ClusteringOptions {
  /** Similarity above which two keywords belong together. */
  threshold?: number;
  minClusterSize?: number;
  maxClusters?: number;
}

/**
 * Group keywords into topical clusters.
 *
 * Uses embeddings when the AI provider has produced them, and falls back to a lexical
 * similarity blend (token Jaccard + shared head term) otherwise, so clustering works on a
 * completely unconfigured install. Single-link agglomerative clustering is deliberate: SEO
 * topics form chains ("workout planner" → "ai workout planner" → "ai gym routine generator")
 * that centroid methods split apart.
 */
export function clusterKeywords(
  keywords: ClusterableKeyword[],
  options: ClusteringOptions = {},
): KeywordClusterResult[] {
  const useEmbeddings = keywords.some((k) => k.embedding?.length);
  const threshold = options.threshold ?? (useEmbeddings ? 0.72 : 0.42);
  const minClusterSize = options.minClusterSize ?? 1;
  const maxClusters = options.maxClusters ?? 400;

  if (keywords.length === 0) return [];

  // Union-find over pairs above the similarity threshold.
  const parent = new Map<string, string>(keywords.map((k) => [k.id, k.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cursor = id;
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor)!;
      parent.set(cursor, root);
      cursor = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  // Pre-index by shared tokens so we only compare plausible pairs — O(n²) is unusable at 50k keywords.
  const tokenIndex = new Map<string, string[]>();
  const tokensById = new Map<string, Set<string>>();
  for (const kw of keywords) {
    const tokens = new Set(tokenize(kw.normalized || normalizeKeyword(kw.keyword)));
    tokensById.set(kw.id, tokens);
    for (const token of tokens) {
      const list = tokenIndex.get(token) ?? [];
      list.push(kw.id);
      tokenIndex.set(token, list);
    }
  }
  const byId = new Map(keywords.map((k) => [k.id, k]));

  const comparedPairs = new Set<string>();
  for (const kw of keywords) {
    const candidateIds = new Set<string>();
    for (const token of tokensById.get(kw.id) ?? []) {
      const bucket = tokenIndex.get(token);
      // Skip tokens that appear almost everywhere — they add no discriminating power.
      if (!bucket || bucket.length > 400) continue;
      for (const id of bucket) if (id !== kw.id) candidateIds.add(id);
    }
    for (const otherId of candidateIds) {
      const pairKey = kw.id < otherId ? `${kw.id}|${otherId}` : `${otherId}|${kw.id}`;
      if (comparedPairs.has(pairKey)) continue;
      comparedPairs.add(pairKey);
      const other = byId.get(otherId);
      if (!other) continue;
      if (similarity(kw, other, useEmbeddings) >= threshold) union(kw.id, otherId);
    }
  }

  const groups = new Map<string, ClusterableKeyword[]>();
  for (const kw of keywords) {
    const root = find(kw.id);
    const list = groups.get(root) ?? [];
    list.push(kw);
    groups.set(root, list);
  }

  const results: KeywordClusterResult[] = [];
  for (const members of groups.values()) {
    if (members.length < minClusterSize) continue;
    results.push(summariseCluster(members));
  }

  return results
    .sort((a, b) => b.totalImpressions - a.totalImpressions || b.keywordIds.length - a.keywordIds.length)
    .slice(0, maxClusters);
}

function similarity(a: ClusterableKeyword, b: ClusterableKeyword, useEmbeddings: boolean): number {
  if (useEmbeddings && a.embedding?.length && b.embedding?.length && a.embedding.length === b.embedding.length) {
    return cosineSimilarity(a.embedding, b.embedding);
  }
  const jaccard = jaccardSimilarity(a.normalized, b.normalized);
  // Containment: "workout planner" ⊂ "ai workout planner" is a strong topical signal that
  // Jaccard alone under-weights because of the length difference.
  const ta = new Set(tokenize(a.normalized));
  const tb = new Set(tokenize(b.normalized));
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size <= tb.size ? tb : ta;
  let contained = 0;
  for (const token of smaller) if (larger.has(token)) contained++;
  const containment = smaller.size ? contained / smaller.size : 0;
  return Math.max(jaccard, containment * 0.85);
}

function summariseCluster(members: ClusterableKeyword[]): KeywordClusterResult {
  const sorted = [...members].sort(
    (a, b) => b.impressions - a.impressions || (b.searchVolume ?? 0) - (a.searchVolume ?? 0) || a.keyword.length - b.keyword.length,
  );
  const head = sorted[0]!;

  const totalImpressions = members.reduce((s, k) => s + k.impressions, 0);
  const totalClicks = members.reduce((s, k) => s + k.clicks, 0);
  const totalVolume = members.reduce((s, k) => s + (k.searchVolume ?? 0), 0);
  const ranked = members.filter((k) => k.position !== null);
  const avgPosition = ranked.length
    ? round(ranked.reduce((s, k) => s + (k.position ?? 0), 0) / ranked.length, 1)
    : null;

  // Which URL already owns most of this cluster? High spread means the topic is fragmented.
  const urlCounts = new Map<string, number>();
  for (const k of members) if (k.rankingUrl) urlCounts.set(k.rankingUrl, (urlCounts.get(k.rankingUrl) ?? 0) + 1);
  const dominant = [...urlCounts.entries()].sort((a, b) => b[1] - a[1])[0];

  // Cluster name: the most common multi-word phrase, falling back to the head keyword.
  const name = pickClusterName(members) ?? head.keyword;

  const intentCounts = new Map<string, number>();
  for (const k of members) intentCounts.set(k.intent, (intentCounts.get(k.intent) ?? 0) + 1);
  const intent = [...intentCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'UNKNOWN';

  const embeddings = members.map((k) => k.embedding).filter((e): e is number[] => Boolean(e?.length));
  const centroid = embeddings.length
    ? embeddings[0]!.map((_, i) => round(embeddings.reduce((s, e) => s + (e[i] ?? 0), 0) / embeddings.length, 6))
    : [];

  return {
    slug: slugify(name),
    name,
    keywordIds: members.map((k) => k.id),
    keywords: sorted.map((k) => k.keyword),
    parentTopic: deriveParentTopic(members),
    intent,
    totalImpressions,
    totalClicks,
    totalVolume,
    avgPosition,
    centroid,
    dominantUrl: dominant?.[0] ?? null,
    urlSpread: urlCounts.size,
  };
}

/** The shortest keyword that is a token-subset of most members reads best as a cluster name. */
function pickClusterName(members: ClusterableKeyword[]): string | null {
  const candidates = [...members].sort((a, b) => a.keyword.length - b.keyword.length).slice(0, 20);
  let best: { keyword: string; coverage: number } | null = null;
  for (const candidate of candidates) {
    const tokens = new Set(tokenize(candidate.normalized));
    if (tokens.size === 0) continue;
    let coverage = 0;
    for (const member of members) {
      const memberTokens = new Set(tokenize(member.normalized));
      let hits = 0;
      for (const t of tokens) if (memberTokens.has(t)) hits++;
      if (hits / tokens.size >= 0.8) coverage++;
    }
    const ratio = coverage / members.length;
    if (!best || ratio > best.coverage) best = { keyword: candidate.keyword, coverage: ratio };
  }
  return best && best.coverage >= 0.5 ? best.keyword : null;
}

/** The most frequent token across the cluster is a decent parent-topic label. */
function deriveParentTopic(members: ClusterableKeyword[]): string | null {
  const counts = new Map<string, number>();
  for (const member of members) {
    for (const token of new Set(tokenize(member.normalized))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  const top = [...counts.entries()]
    .filter(([token]) => token.length > 3)
    .sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= Math.max(2, members.length * 0.6) ? top[0] : null;
}

export interface ClusterArchitecture {
  clusterSlug: string;
  clusterName: string;
  pillar: { url: string | null; suggestedTitle: string; targetKeyword: string; exists: boolean };
  supporting: Array<{ url: string | null; suggestedTitle: string; targetKeyword: string; exists: boolean }>;
  cannibalizationRisk: 'high' | 'medium' | 'low';
  notes: string;
}

/**
 * Turn a cluster into a pillar/supporting architecture proposal.
 *
 * Refuses to propose new pages where an existing URL already covers the sub-topic — the spec's
 * "do NOT create unnecessary pages" rule is enforced here, not left to the LLM.
 */
export function proposeClusterArchitecture(
  cluster: KeywordClusterResult,
  existingPages: Array<{ url: string; title: string | null; targetKeywords: string[] }>,
): ClusterArchitecture {
  const covered = new Map<string, string>(); // normalised keyword → url
  for (const page of existingPages) {
    for (const kw of page.targetKeywords) covered.set(normalizeKeyword(kw), page.url);
  }

  const headKeyword = cluster.keywords[0] ?? cluster.name;
  const pillarUrl = cluster.dominantUrl ?? covered.get(normalizeKeyword(headKeyword)) ?? null;

  // Supporting topics are the distinct sub-intents, not every keyword variant.
  const supportingKeywords = cluster.keywords
    .slice(1)
    .filter((kw) => {
      const tokens = new Set(tokenize(kw));
      const headTokens = new Set(tokenize(headKeyword));
      let extra = 0;
      for (const t of tokens) if (!headTokens.has(t)) extra++;
      return extra >= 1; // must add something beyond the head term
    })
    .slice(0, 8);

  const supporting = supportingKeywords.map((keyword) => {
    const url = covered.get(normalizeKeyword(keyword)) ?? null;
    return {
      url,
      suggestedTitle: toTitleCase(keyword),
      targetKeyword: keyword,
      exists: Boolean(url),
    };
  });

  const cannibalizationRisk =
    cluster.urlSpread >= 4 ? 'high' : cluster.urlSpread >= 2 ? 'medium' : 'low';

  return {
    clusterSlug: cluster.slug,
    clusterName: cluster.name,
    pillar: {
      url: pillarUrl,
      suggestedTitle: toTitleCase(headKeyword),
      targetKeyword: headKeyword,
      exists: Boolean(pillarUrl),
    },
    supporting,
    cannibalizationRisk,
    notes:
      cannibalizationRisk === 'high'
        ? `${cluster.urlSpread} different URLs already rank inside this cluster. Consolidate before publishing anything new — adding pages here would deepen the cannibalisation.`
        : pillarUrl
          ? `${pillarUrl} already acts as the hub for this topic. Strengthen it and link the supporting pages into it.`
          : 'No page owns this topic yet. A pillar page plus the supporting articles below is the cleanest structure.',
  };
}

function toTitleCase(text: string): string {
  const minor = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'for', 'to', 'of', 'in', 'on', 'at', 'vs']);
  return text
    .split(/\s+/)
    .map((word, i) =>
      i > 0 && minor.has(word.toLowerCase()) ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}
