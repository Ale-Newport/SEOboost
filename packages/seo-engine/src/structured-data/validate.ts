/**
 * JSON-LD validation.
 *
 * Checks structure and the required/recommended properties Google documents for each type.
 * This is not a full Schema.org validator — it is the subset that actually causes rich results
 * to be withheld, plus the integrity rules this product enforces (no markup for content that is
 * not visibly on the page).
 */

export type ValidationStatus = 'VALID' | 'WARNING' | 'INVALID';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ValidationResult {
  status: ValidationStatus;
  types: string[];
  issues: ValidationIssue[];
}

/** Required and recommended properties per type, per Google's structured-data documentation. */
const TYPE_RULES: Record<string, { required: string[]; recommended: string[] }> = {
  Organization: { required: ['name'], recommended: ['url', 'logo', 'sameAs', 'description'] },
  WebSite: { required: ['name', 'url'], recommended: ['potentialAction', 'publisher'] },
  WebPage: { required: ['name'], recommended: ['url', 'description', 'isPartOf'] },
  Article: { required: ['headline'], recommended: ['author', 'datePublished', 'dateModified', 'image', 'publisher'] },
  BlogPosting: { required: ['headline'], recommended: ['author', 'datePublished', 'dateModified', 'image', 'publisher'] },
  NewsArticle: { required: ['headline', 'datePublished'], recommended: ['author', 'image', 'publisher', 'dateModified'] },
  BreadcrumbList: { required: ['itemListElement'], recommended: [] },
  Person: { required: ['name'], recommended: ['url', 'jobTitle', 'sameAs', 'description'] },
  Product: { required: ['name'], recommended: ['image', 'description', 'offers', 'brand', 'aggregateRating'] },
  SoftwareApplication: {
    required: ['name', 'applicationCategory'],
    recommended: ['operatingSystem', 'offers', 'aggregateRating', 'description', 'url'],
  },
  FAQPage: { required: ['mainEntity'], recommended: [] },
  HowTo: { required: ['name', 'step'], recommended: ['totalTime', 'supply', 'tool', 'image'] },
  VideoObject: { required: ['name', 'thumbnailUrl', 'uploadDate'], recommended: ['description', 'duration', 'contentUrl'] },
  Review: { required: ['itemReviewed', 'reviewRating', 'author'], recommended: ['datePublished', 'reviewBody'] },
  AggregateRating: { required: ['ratingValue'], recommended: ['reviewCount', 'ratingCount', 'bestRating'] },
  LocalBusiness: { required: ['name', 'address'], recommended: ['telephone', 'openingHoursSpecification', 'geo', 'url'] },
  Service: { required: ['name'], recommended: ['provider', 'areaServed', 'description'] },
  ItemList: { required: ['itemListElement'], recommended: ['numberOfItems', 'name'] },
  Course: { required: ['name', 'description'], recommended: ['provider', 'offers'] },
  Event: { required: ['name', 'startDate'], recommended: ['location', 'endDate', 'offers', 'organizer'] },
  Recipe: { required: ['name', 'recipeIngredient', 'recipeInstructions'], recommended: ['image', 'author', 'nutrition'] },
  CollectionPage: { required: ['name'], recommended: ['url', 'description'] },
  AboutPage: { required: ['name'], recommended: ['url', 'description'] },
  ContactPage: { required: ['name'], recommended: ['url'] },
  ProfilePage: { required: ['mainEntity'], recommended: ['url'] },
};

export function validateJsonLd(input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const types: string[] = [];

  if (input === null || input === undefined) {
    return { status: 'INVALID', types: [], issues: [{ severity: 'error', path: '$', message: 'Empty structured data block.' }] };
  }

  const nodes = collectNodes(input);
  if (nodes.length === 0) {
    issues.push({ severity: 'error', path: '$', message: 'No schema nodes with an @type were found.' });
    return { status: 'INVALID', types: [], issues };
  }

  const root = asRecord(input);
  if (root && !('@context' in root) && !Array.isArray(input)) {
    issues.push({
      severity: 'warning',
      path: '$',
      message: 'Missing @context. Add "@context": "https://schema.org" so the vocabulary resolves.',
    });
  } else if (root && typeof root['@context'] === 'string') {
    const context = root['@context'];
    if (!/schema\.org/i.test(context)) {
      issues.push({ severity: 'error', path: '$.@context', message: `@context must reference schema.org, found "${context}".` });
    }
  }

  for (const { node, path } of nodes) {
    const nodeTypes = normalizeTypes(node['@type']);
    types.push(...nodeTypes);

    for (const type of nodeTypes) {
      const rules = TYPE_RULES[type];
      if (!rules) continue; // unknown types are legal; we just cannot check them

      for (const property of rules.required) {
        if (!hasMeaningfulValue(node[property])) {
          issues.push({
            severity: 'error',
            path: `${path}.${property}`,
            message: `${type} requires "${property}". Rich results are withheld without it.`,
          });
        }
      }
      for (const property of rules.recommended) {
        if (!hasMeaningfulValue(node[property])) {
          issues.push({
            severity: 'warning',
            path: `${path}.${property}`,
            message: `${type} recommends "${property}".`,
          });
        }
      }
    }

    // Type-specific structural checks
    if (nodeTypes.includes('FAQPage')) validateFaq(node, path, issues);
    if (nodeTypes.includes('BreadcrumbList')) validateBreadcrumbs(node, path, issues);
    if (nodeTypes.includes('AggregateRating')) validateAggregateRating(node, path, issues);

    // Dates must be ISO 8601 or engines silently drop them.
    for (const dateProperty of ['datePublished', 'dateModified', 'uploadDate', 'startDate', 'endDate']) {
      const value = node[dateProperty];
      if (typeof value === 'string' && !isIsoDate(value)) {
        issues.push({
          severity: 'error',
          path: `${path}.${dateProperty}`,
          message: `"${dateProperty}" must be an ISO 8601 date (e.g. 2026-01-31 or 2026-01-31T10:00:00Z), found "${value}".`,
        });
      }
    }

    for (const urlProperty of ['url', 'contentUrl', 'thumbnailUrl', 'logo', 'image']) {
      const value = node[urlProperty];
      if (typeof value === 'string' && value && !/^https?:\/\//i.test(value) && !value.startsWith('#')) {
        issues.push({
          severity: 'warning',
          path: `${path}.${urlProperty}`,
          message: `"${urlProperty}" should be an absolute URL, found "${value}".`,
        });
      }
    }
  }

  const hasError = issues.some((i) => i.severity === 'error');
  return {
    status: hasError ? 'INVALID' : issues.length > 0 ? 'WARNING' : 'VALID',
    types: [...new Set(types)],
    issues,
  };
}

function validateFaq(node: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  const mainEntity = node.mainEntity;
  const entities = Array.isArray(mainEntity) ? mainEntity : mainEntity ? [mainEntity] : [];
  if (entities.length === 0) {
    issues.push({ severity: 'error', path: `${path}.mainEntity`, message: 'FAQPage needs at least one Question.' });
    return;
  }
  entities.forEach((entity, index) => {
    const question = asRecord(entity);
    if (!question) return;
    if (!hasMeaningfulValue(question.name)) {
      issues.push({ severity: 'error', path: `${path}.mainEntity[${index}].name`, message: 'Each Question needs a "name" (the question text).' });
    }
    const answer = asRecord(question.acceptedAnswer);
    if (!answer || !hasMeaningfulValue(answer.text)) {
      issues.push({
        severity: 'error',
        path: `${path}.mainEntity[${index}].acceptedAnswer.text`,
        message: 'Each Question needs an acceptedAnswer with non-empty "text".',
      });
    }
  });
}

function validateBreadcrumbs(node: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  const list = node.itemListElement;
  if (!Array.isArray(list) || list.length === 0) {
    issues.push({ severity: 'error', path: `${path}.itemListElement`, message: 'BreadcrumbList needs a non-empty itemListElement array.' });
    return;
  }
  const positions: number[] = [];
  list.forEach((raw, index) => {
    const item = asRecord(raw);
    if (!item) return;
    if (typeof item.position !== 'number') {
      issues.push({ severity: 'error', path: `${path}.itemListElement[${index}].position`, message: 'Each ListItem needs a numeric "position".' });
    } else {
      positions.push(item.position);
    }
    if (!hasMeaningfulValue(item.name) && !hasMeaningfulValue(asRecord(item.item)?.name)) {
      issues.push({ severity: 'error', path: `${path}.itemListElement[${index}].name`, message: 'Each ListItem needs a "name".' });
    }
  });
  const sorted = [...positions].sort((a, b) => a - b);
  if (sorted.some((p, i) => p !== i + 1)) {
    issues.push({
      severity: 'warning',
      path: `${path}.itemListElement`,
      message: `Breadcrumb positions should be consecutive starting at 1, found ${sorted.join(', ')}.`,
    });
  }
}

function validateAggregateRating(node: Record<string, unknown>, path: string, issues: ValidationIssue[]): void {
  const value = Number(node.ratingValue);
  const best = Number(node.bestRating ?? 5);
  const worst = Number(node.worstRating ?? 1);
  if (Number.isFinite(value) && (value > best || value < worst)) {
    issues.push({
      severity: 'error',
      path: `${path}.ratingValue`,
      message: `ratingValue ${value} is outside the ${worst}-${best} range.`,
    });
  }
  if (!hasMeaningfulValue(node.reviewCount) && !hasMeaningfulValue(node.ratingCount)) {
    issues.push({
      severity: 'error',
      path: `${path}.reviewCount`,
      message: 'AggregateRating needs reviewCount or ratingCount. Never publish a rating without real review data behind it.',
    });
  }
}

function collectNodes(input: unknown, path = '$', depth = 0): Array<{ node: Record<string, unknown>; path: string }> {
  if (depth > 8) return [];
  const out: Array<{ node: Record<string, unknown>; path: string }> = [];
  if (Array.isArray(input)) {
    input.forEach((item, index) => out.push(...collectNodes(item, `${path}[${index}]`, depth + 1)));
    return out;
  }
  const record = asRecord(input);
  if (!record) return out;

  if ('@type' in record) out.push({ node: record, path });

  const graph = record['@graph'];
  if (Array.isArray(graph)) {
    graph.forEach((item, index) => out.push(...collectNodes(item, `${path}.@graph[${index}]`, depth + 1)));
  }
  // Nested typed objects (author, publisher, offers, aggregateRating…) are validated too.
  for (const [key, value] of Object.entries(record)) {
    if (key === '@graph' || key.startsWith('@')) continue;
    if (value && typeof value === 'object') {
      out.push(...collectNodes(value, `${path}.${key}`, depth + 1));
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizeTypes(value: unknown): string[] {
  if (typeof value === 'string') return [value.replace(/^https?:\/\/schema\.org\//i, '')];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  return [];
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** Parse a raw <script type="application/ld+json"> body, tolerating trailing commas and HTML comments. */
export function parseJsonLd(raw: string): { data: unknown; error: string | null } {
  const cleaned = raw
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .replace(/,\s*([}\]])/g, '$1')
    .trim();
  try {
    return { data: JSON.parse(cleaned), error: null };
  } catch (err) {
    return { data: null, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

/** ISO 8601 date or date-time, which is what search engines require for date properties. */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value.trim())) {
    return false;
  }
  return !Number.isNaN(new Date(value.trim().replace(' ', 'T')).getTime());
}
