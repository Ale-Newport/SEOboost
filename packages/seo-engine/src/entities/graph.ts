import { clamp, containsPhrase, normalizeKeyword, round, tokenize } from '@seo/shared';

export type EntityTypeValue =
  | 'BRAND' | 'WEBSITE' | 'COMPANY' | 'PRODUCT' | 'SERVICE' | 'PERSON' | 'TOPIC'
  | 'ORGANIZATION' | 'LOCATION' | 'SOFTWARE' | 'FEATURE' | 'EVENT' | 'CONCEPT';

export interface EntityCandidate {
  name: string;
  type: EntityTypeValue;
  description?: string | null;
  aliases: string[];
  confidence: number;
  mentionCount: number;
  source: 'schema' | 'knowledge-base' | 'content' | 'ai';
  canonicalUrl?: string | null;
  sameAs?: string[];
}

export interface EntityRelationCandidate {
  from: string;
  to: string;
  relation: string;
  weight: number;
  evidence?: string;
}

export interface EntityExtractionInput {
  brandName: string | null;
  domain: string;
  siteName: string;
  knowledgeBase: {
    businessDescription?: string | null;
    products?: Array<{ name: string; description?: string; url?: string }>;
    terminology?: Array<{ term: string; definition: string }>;
    authorBios?: Array<{ name: string; title?: string; bio?: string; url?: string }>;
  };
  pages: Array<{
    url: string;
    title: string | null;
    h1: string | null;
    textContent: string | null;
    structuredData: unknown[];
    pageType: string;
  }>;
  /** Cluster names double as topic entities. */
  topicNames: string[];
}

/**
 * Build the site's entity graph from things we can actually observe: structured data already on
 * the site, the operator's knowledge base, and repeated proper-noun usage in content.
 *
 * Deliberately does NOT invent entities. The LLM entity-extraction prompt runs on top of this and
 * can only *enrich* what deterministic extraction found, never conjure new companies or people.
 */
export function extractEntities(input: EntityExtractionInput): {
  entities: EntityCandidate[];
  relationships: EntityRelationCandidate[];
} {
  const entities = new Map<string, EntityCandidate>();
  const relationships: EntityRelationCandidate[] = [];

  const upsert = (candidate: EntityCandidate) => {
    const key = `${normalizeKeyword(candidate.name)}|${candidate.type}`;
    const existing = entities.get(key);
    if (existing) {
      existing.mentionCount += candidate.mentionCount;
      existing.confidence = Math.max(existing.confidence, candidate.confidence);
      existing.description = existing.description ?? candidate.description ?? null;
      existing.canonicalUrl = existing.canonicalUrl ?? candidate.canonicalUrl ?? null;
      for (const alias of candidate.aliases) if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
      for (const same of candidate.sameAs ?? []) {
        existing.sameAs = existing.sameAs ?? [];
        if (!existing.sameAs.includes(same)) existing.sameAs.push(same);
      }
      // Knowledge-base and schema sources outrank content inference.
      if (rank(candidate.source) > rank(existing.source)) existing.source = candidate.source;
    } else {
      entities.set(key, { ...candidate });
    }
  };

  // 1. The brand itself — the root of the graph.
  const brandName = input.brandName ?? input.siteName;
  if (brandName) {
    upsert({
      name: brandName,
      type: 'BRAND',
      description: input.knowledgeBase.businessDescription ?? null,
      aliases: input.brandName && input.siteName !== input.brandName ? [input.siteName] : [],
      confidence: 1,
      mentionCount: 0,
      source: 'knowledge-base',
      canonicalUrl: `https://${input.domain}`,
    });
    upsert({
      name: input.domain,
      type: 'WEBSITE',
      description: `The website for ${brandName}.`,
      aliases: [],
      confidence: 1,
      mentionCount: 0,
      source: 'knowledge-base',
      canonicalUrl: `https://${input.domain}`,
    });
    relationships.push({
      from: brandName,
      to: input.domain,
      relation: 'operates',
      weight: 1,
      evidence: 'Site configuration',
    });
  }

  // 2. Products and services from the knowledge base.
  for (const product of input.knowledgeBase.products ?? []) {
    if (!product.name?.trim()) continue;
    upsert({
      name: product.name.trim(),
      type: 'PRODUCT',
      description: product.description ?? null,
      aliases: [],
      confidence: 0.95,
      mentionCount: 0,
      source: 'knowledge-base',
      canonicalUrl: product.url ?? null,
    });
    if (brandName) {
      relationships.push({
        from: brandName,
        to: product.name.trim(),
        relation: 'develops',
        weight: 1,
        evidence: 'Declared in the site knowledge base',
      });
    }
  }

  // 3. People from author bios.
  for (const author of input.knowledgeBase.authorBios ?? []) {
    if (!author.name?.trim()) continue;
    upsert({
      name: author.name.trim(),
      type: 'PERSON',
      description: author.bio ?? author.title ?? null,
      aliases: [],
      confidence: 0.95,
      mentionCount: 0,
      source: 'knowledge-base',
      canonicalUrl: author.url ?? null,
    });
    if (brandName) {
      relationships.push({
        from: author.name.trim(),
        to: brandName,
        relation: 'works for',
        weight: 0.9,
        evidence: 'Author profile in the knowledge base',
      });
    }
  }

  // 4. Concepts from the operator's terminology list.
  for (const term of input.knowledgeBase.terminology ?? []) {
    if (!term.term?.trim()) continue;
    upsert({
      name: term.term.trim(),
      type: 'CONCEPT',
      description: term.definition,
      aliases: [],
      confidence: 0.9,
      mentionCount: 0,
      source: 'knowledge-base',
    });
  }

  // 5. Entities already declared in the site's own structured data — the most reliable source.
  for (const page of input.pages) {
    for (const node of flattenJsonLd(page.structuredData)) {
      const type = mapSchemaTypeToEntityType(node.type);
      if (!type || !node.name) continue;
      upsert({
        name: node.name,
        type,
        description: node.description ?? null,
        aliases: [],
        confidence: 0.9,
        mentionCount: 1,
        source: 'schema',
        canonicalUrl: node.url ?? page.url,
        sameAs: node.sameAs,
      });
      if (type === 'PERSON' && brandName) {
        relationships.push({ from: node.name, to: brandName, relation: 'works for', weight: 0.7, evidence: `Schema on ${page.url}` });
      }
    }
  }

  // 6. Topic entities from keyword clusters.
  for (const topic of input.topicNames) {
    if (!topic?.trim()) continue;
    upsert({
      name: topic.trim(),
      type: 'TOPIC',
      description: null,
      aliases: [],
      confidence: 0.7,
      mentionCount: 0,
      source: 'content',
    });
    if (brandName) {
      relationships.push({ from: brandName, to: topic.trim(), relation: 'covers topic', weight: 0.6, evidence: 'Keyword cluster' });
    }
  }

  // 7. Count real mentions across content, and drop content-derived entities that barely appear.
  const allText = input.pages
    .map((p) => `${p.title ?? ''} ${p.h1 ?? ''} ${(p.textContent ?? '').slice(0, 6000)}`)
    .join('\n');
  for (const entity of entities.values()) {
    entity.mentionCount = Math.max(entity.mentionCount, countMentions(allText, entity.name));
  }

  // Article → topic relationships, derived from actual page content.
  const topics = [...entities.values()].filter((e) => e.type === 'TOPIC');
  for (const page of input.pages) {
    if (!['ARTICLE', 'BLOG_INDEX', 'GLOSSARY', 'COMPARISON'].includes(page.pageType)) continue;
    const haystack = `${page.title ?? ''} ${page.h1 ?? ''} ${(page.textContent ?? '').slice(0, 3000)}`;
    for (const topic of topics) {
      if (containsPhrase(haystack, topic.name)) {
        relationships.push({
          from: page.url,
          to: topic.name,
          relation: 'discusses',
          weight: 0.6,
          evidence: `Mentioned on ${page.url}`,
        });
      }
    }
  }

  const filtered = [...entities.values()].filter(
    (e) => e.source !== 'content' || e.mentionCount >= 2,
  );

  return {
    entities: filtered.sort((a, b) => b.confidence - a.confidence || b.mentionCount - a.mentionCount),
    relationships: dedupeRelationships(relationships),
  };
}

function rank(source: EntityCandidate['source']): number {
  return source === 'knowledge-base' ? 4 : source === 'schema' ? 3 : source === 'ai' ? 2 : 1;
}

interface FlatJsonLdNode {
  type: string;
  name: string | null;
  description: string | null;
  url: string | null;
  sameAs: string[];
}

function flattenJsonLd(blocks: unknown[], depth = 0): FlatJsonLdNode[] {
  if (depth > 5) return [];
  const out: FlatJsonLdNode[] = [];
  for (const block of blocks) {
    if (Array.isArray(block)) {
      out.push(...flattenJsonLd(block, depth + 1));
      continue;
    }
    if (!block || typeof block !== 'object') continue;
    const record = block as Record<string, unknown>;
    if (Array.isArray(record['@graph'])) out.push(...flattenJsonLd(record['@graph'] as unknown[], depth + 1));

    const rawType = record['@type'];
    const types = typeof rawType === 'string' ? [rawType] : Array.isArray(rawType) ? rawType.filter((t): t is string => typeof t === 'string') : [];
    for (const type of types) {
      out.push({
        type,
        name: typeof record.name === 'string' ? record.name : typeof record.headline === 'string' ? record.headline : null,
        description: typeof record.description === 'string' ? record.description : null,
        url: typeof record.url === 'string' ? record.url : null,
        sameAs: Array.isArray(record.sameAs) ? record.sameAs.filter((s): s is string => typeof s === 'string') : [],
      });
    }
    for (const key of ['author', 'publisher', 'brand', 'provider', 'itemReviewed']) {
      const nested = record[key];
      if (nested && typeof nested === 'object') out.push(...flattenJsonLd([nested], depth + 1));
    }
  }
  return out;
}

function mapSchemaTypeToEntityType(schemaType: string): EntityTypeValue | null {
  const type = schemaType.replace(/^https?:\/\/schema\.org\//i, '');
  const map: Record<string, EntityTypeValue> = {
    Organization: 'ORGANIZATION', Corporation: 'COMPANY', LocalBusiness: 'COMPANY',
    Person: 'PERSON', Product: 'PRODUCT', SoftwareApplication: 'SOFTWARE',
    WebApplication: 'SOFTWARE', MobileApplication: 'SOFTWARE', Service: 'SERVICE',
    Place: 'LOCATION', PostalAddress: 'LOCATION', Event: 'EVENT', Brand: 'BRAND',
    WebSite: 'WEBSITE',
  };
  return map[type] ?? null;
}

function countMentions(text: string, name: string): number {
  if (!name || name.length < 3) return 0;
  const tokens = tokenize(name);
  if (tokens.length === 0) return 0;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    const matches = text.match(new RegExp(`\\b${escaped}\\b`, 'gi'));
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function dedupeRelationships(relationships: EntityRelationCandidate[]): EntityRelationCandidate[] {
  const map = new Map<string, EntityRelationCandidate>();
  for (const relation of relationships) {
    const key = `${normalizeKeyword(relation.from)}|${relation.relation}|${normalizeKeyword(relation.to)}`;
    const existing = map.get(key);
    if (existing) existing.weight = clamp(Math.max(existing.weight, relation.weight));
    else map.set(key, { ...relation, weight: clamp(relation.weight) });
  }
  return [...map.values()];
}

/** Entity coverage: how well the site's most important entities are actually explained. */
export function scoreEntityCoverage(
  entities: EntityCandidate[],
  pages: Array<{ url: string; pageType: string; textContent: string | null }>,
): { score: number; gaps: Array<{ entity: string; type: string; issue: string; recommendation: string }> } {
  const gaps: Array<{ entity: string; type: string; issue: string; recommendation: string }> = [];
  const important = entities.filter((e) => ['BRAND', 'PRODUCT', 'SERVICE', 'SOFTWARE', 'COMPANY', 'PERSON'].includes(e.type));
  if (important.length === 0) {
    return {
      score: 0,
      gaps: [
        {
          entity: '—',
          type: 'BRAND',
          issue: 'No brand, product or person entities could be identified for this site.',
          recommendation:
            'Fill in the site knowledge base (brand name, products, authors) and add Organization schema. Answer engines ' +
            'cannot describe what the site never names.',
        },
      ],
    };
  }

  let covered = 0;
  for (const entity of important) {
    const hasDescription = Boolean(entity.description?.trim());
    const hasDedicatedPage = pages.some(
      (p) => p.textContent && containsPhrase(p.textContent.slice(0, 2000), entity.name),
    );
    if (hasDescription && hasDedicatedPage && entity.mentionCount >= 3) {
      covered++;
      continue;
    }
    gaps.push({
      entity: entity.name,
      type: entity.type,
      issue: !hasDescription
        ? 'No description — the site never states what this is.'
        : !hasDedicatedPage
          ? 'Mentioned but never explained prominently on any page.'
          : `Only ${entity.mentionCount} mention(s) across the site.`,
      recommendation: !hasDescription
        ? `Write one canonical sentence defining "${entity.name}" and use it consistently across the site and in schema.`
        : `Give "${entity.name}" a page (or a prominent section) that defines it, states its category and links to related entities.`,
    });
  }

  return { score: round((covered / important.length) * 100, 1), gaps };
}
