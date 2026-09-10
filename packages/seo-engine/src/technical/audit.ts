import { SEO_THRESHOLDS, getHostname, isSameSite, looksLikeCrawlTrap, normalizeUrl, truncate } from '@seo/shared';
import { fingerprint } from '@seo/shared/crypto';
import { simhashDistance } from '@seo/shared/hash';
import { RULES, type RuleId } from './catalogue';
import type { AuditDataset, AuditPage, IssueDraft } from '../types';

interface RuleContext {
  dataset: AuditDataset;
  byNormalized: Map<string, AuditPage>;
  inboundCounts: Map<string, number>;
  outboundCounts: Map<string, number>;
}

/** Impact multiplier for a page: shallow, well-linked pages matter more when they break. */
function pageImportance(page: AuditPage | undefined, ctx: RuleContext): number {
  if (!page) return 0.4;
  const inbound = ctx.inboundCounts.get(page.normalizedUrl) ?? 0;
  const depthFactor = page.depth <= 1 ? 1 : page.depth <= 3 ? 0.75 : 0.5;
  const linkFactor = inbound >= 20 ? 1 : inbound >= 5 ? 0.8 : inbound >= 1 ? 0.6 : 0.4;
  return Math.min(1, depthFactor * 0.6 + linkFactor * 0.4);
}

const SEVERITY_IMPACT: Record<string, number> = {
  CRITICAL: 1, HIGH: 0.75, MEDIUM: 0.45, LOW: 0.2, INFO: 0.05,
};

function draft(
  ruleId: RuleId,
  opts: {
    url: string | null;
    description: string;
    recommendation: string;
    evidence?: Record<string, unknown>;
    confidence?: number;
    impactMultiplier?: number;
    /** Extra discriminator so two findings of the same rule on the same URL stay distinct. */
    key?: string;
    severityOverride?: IssueDraft['severity'];
  },
  websiteId: string,
): IssueDraft {
  const rule = RULES[ruleId];
  const severity = opts.severityOverride ?? rule.severity;
  const base = SEVERITY_IMPACT[severity] ?? 0.3;
  return {
    ruleId: rule.id,
    title: rule.title,
    category: rule.category,
    severity,
    url: opts.url,
    description: opts.description,
    recommendation: opts.recommendation,
    evidence: opts.evidence ?? {},
    estimatedImpact: Math.round(base * (opts.impactMultiplier ?? 1) * 100) / 100,
    confidence: opts.confidence ?? 0.9,
    autoFixable: rule.autoFixable,
    weight: rule.weight,
    scope: rule.scope,
    fingerprint: fingerprint(websiteId, rule.id, opts.url ?? 'site', opts.key ?? ''),
  };
}

function buildContext(dataset: AuditDataset): RuleContext {
  const byNormalized = new Map<string, AuditPage>();
  for (const page of dataset.pages) byNormalized.set(page.normalizedUrl, page);

  const inboundCounts = new Map<string, number>();
  const outboundCounts = new Map<string, number>();
  for (const edge of dataset.edges) {
    // Self-links do not count as internal equity.
    if (edge.from === edge.to) continue;
    inboundCounts.set(edge.to, (inboundCounts.get(edge.to) ?? 0) + 1);
    outboundCounts.set(edge.from, (outboundCounts.get(edge.from) ?? 0) + 1);
  }
  return { dataset, byNormalized, inboundCounts, outboundCounts };
}

// ─────────────────────────────────────────────────────────────────────────────
// Page-level rules
// ─────────────────────────────────────────────────────────────────────────────

function auditStatus(page: AuditPage, ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const importance = pageImportance(page, ctx);
  const inbound = ctx.inboundCounts.get(page.normalizedUrl) ?? 0;

  if (page.error && page.statusCode === null) {
    out.push(
      draft('FETCH_FAILED', {
        url: page.url,
        description: `The crawler could not fetch this URL: ${page.error}`,
        recommendation:
          'Check server availability, DNS, TLS certificate and any firewall or bot protection that may be blocking the crawler user agent.',
        evidence: { error: page.error, inboundLinks: inbound },
        impactMultiplier: importance,
      }, websiteId),
    );
    return out;
  }

  const status = page.statusCode ?? 0;
  if (status >= 500) {
    out.push(
      draft('HTTP_5XX', {
        url: page.url,
        description: `The server returned ${status} for this URL. ${inbound} internal link(s) point at it.`,
        recommendation: 'Investigate the application error. Server errors stop indexing and can drop existing rankings.',
        evidence: { statusCode: status, inboundLinks: inbound },
        impactMultiplier: importance,
      }, websiteId),
    );
  } else if (status === 404) {
    out.push(
      draft('HTTP_404', {
        url: page.url,
        description:
          inbound > 0
            ? `This URL returns 404 but ${inbound} internal link(s) still point at it.`
            : 'This URL returns 404.',
        recommendation:
          inbound > 0
            ? 'Either restore the page, 301-redirect it to the closest relevant page, or update the internal links that reference it.'
            : 'Confirm the removal was intentional; if the URL had backlinks or traffic, redirect it to the closest relevant page.',
        evidence: { statusCode: 404, inboundLinks: inbound },
        impactMultiplier: importance,
        severityOverride: inbound > 0 ? 'HIGH' : 'MEDIUM',
      }, websiteId),
    );
  } else if (status === 410) {
    out.push(
      draft('HTTP_410', {
        url: page.url,
        description: 'This URL returns 410 Gone.',
        recommendation: 'Confirm the permanent removal was intentional and remove any remaining internal links.',
        evidence: { statusCode: 410, inboundLinks: inbound },
        impactMultiplier: importance,
      }, websiteId),
    );
  } else if (status >= 400) {
    out.push(
      draft('HTTP_4XX_OTHER', {
        url: page.url,
        description: `The server returned ${status} for this URL.`,
        recommendation:
          status === 403
            ? 'The crawler is being blocked. Allow the configured user agent, or relax the rate limit if the block is throttling-related.'
            : 'Investigate why this URL is unreachable to crawlers.',
        evidence: { statusCode: status, inboundLinks: inbound },
        impactMultiplier: importance,
      }, websiteId),
    );
  }

  if (page.redirectChain.length >= SEO_THRESHOLDS.redirectChain.warn) {
    const looped = new Set(page.redirectChain).size !== page.redirectChain.length;
    if (looped) {
      out.push(
        draft('REDIRECT_LOOP', {
          url: page.url,
          description: `Following this URL produced a redirect loop: ${page.redirectChain.join(' → ')}`,
          recommendation: 'Break the loop so the URL resolves to a single final destination.',
          evidence: { chain: page.redirectChain },
          impactMultiplier: importance,
        }, websiteId),
      );
    } else {
      out.push(
        draft('REDIRECT_CHAIN', {
          url: page.url,
          description: `This URL redirects ${page.redirectChain.length} times before resolving: ${page.redirectChain.join(' → ')}`,
          recommendation: 'Point the first URL directly at the final destination to remove the intermediate hops.',
          evidence: { chain: page.redirectChain, hops: page.redirectChain.length },
          impactMultiplier: importance,
          severityOverride: page.redirectChain.length >= SEO_THRESHOLDS.redirectChain.critical ? 'HIGH' : 'MEDIUM',
        }, websiteId),
      );
    }
  }

  if (page.responseTimeMs !== null && page.responseTimeMs > SEO_THRESHOLDS.responseTimeMs.warn) {
    out.push(
      draft('SLOW_RESPONSE', {
        url: page.url,
        description: `Server responded in ${(page.responseTimeMs / 1000).toFixed(1)}s.`,
        recommendation: 'Profile the server response: caching, database queries and third-party calls are the usual causes.',
        evidence: { responseTimeMs: page.responseTimeMs },
        impactMultiplier: importance,
        severityOverride: page.responseTimeMs > SEO_THRESHOLDS.responseTimeMs.critical ? 'HIGH' : 'MEDIUM',
        confidence: 0.7,
      }, websiteId),
    );
  }

  if (page.contentBytes !== null && page.contentBytes > SEO_THRESHOLDS.pageSizeBytes.warn) {
    out.push(
      draft('LARGE_PAGE', {
        url: page.url,
        description: `The HTML document is ${(page.contentBytes / 1_000_000).toFixed(1)} MB.`,
        recommendation: 'Reduce inlined data, oversized markup or embedded assets so the document parses faster.',
        evidence: { bytes: page.contentBytes },
        impactMultiplier: importance,
        severityOverride: page.contentBytes > SEO_THRESHOLDS.pageSizeBytes.critical ? 'MEDIUM' : 'LOW',
      }, websiteId),
    );
  }

  const trap = looksLikeCrawlTrap(page.url);
  if (trap.trap) {
    out.push(
      draft('CRAWL_TRAP', {
        url: page.url,
        description: `This URL matches a crawl-trap pattern: ${trap.reason}.`,
        recommendation:
          'Add a canonical to the clean URL, block the parameter pattern in robots.txt, or noindex the generated variants.',
        evidence: { reason: trap.reason },
        confidence: 0.6,
        impactMultiplier: importance * 0.7,
      }, websiteId),
    );
  }

  return out;
}

function auditIndexability(page: AuditPage, ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const importance = pageImportance(page, ctx);
  const isHtml = (page.statusCode ?? 0) >= 200 && (page.statusCode ?? 0) < 300;
  if (!isHtml) return out;

  const metaRobots = (page.robotsMeta ?? '').toLowerCase();
  const xRobots = (page.xRobotsTag ?? '').toLowerCase();
  const metaNoindex = metaRobots.includes('noindex');
  const xNoindex = xRobots.includes('noindex');

  if (metaNoindex || xNoindex) {
    out.push(
      draft('NOINDEX_PAGE', {
        url: page.url,
        description: `This page is excluded from indexing by ${metaNoindex ? 'a meta robots tag' : 'the X-Robots-Tag header'}.`,
        recommendation: 'Confirm this is intentional. If the page should rank, remove the noindex directive.',
        evidence: { robotsMeta: page.robotsMeta, xRobotsTag: page.xRobotsTag },
        impactMultiplier: importance * 0.5,
        confidence: 1,
      }, websiteId),
    );
  }

  if ((metaNoindex && xRobots.includes('index') && !xNoindex) || (xNoindex && metaRobots.includes('index') && !metaNoindex)) {
    out.push(
      draft('CONFLICTING_ROBOTS_DIRECTIVES', {
        url: page.url,
        description: `Meta robots ("${page.robotsMeta}") and X-Robots-Tag ("${page.xRobotsTag}") disagree.`,
        recommendation: 'Set the directive in exactly one place so indexing behaviour is predictable.',
        evidence: { robotsMeta: page.robotsMeta, xRobotsTag: page.xRobotsTag },
        impactMultiplier: importance,
      }, websiteId),
    );
  }

  if (!page.canonicalUrl) {
    out.push(
      draft('MISSING_CANONICAL', {
        url: page.url,
        description: 'This page has no canonical tag.',
        recommendation: 'Add a self-referencing canonical so parameter and protocol variants consolidate onto one URL.',
        evidence: {},
        impactMultiplier: importance * 0.6,
      }, websiteId),
    );
  } else {
    const canonicalNormalized = normalizeUrl(page.canonicalUrl);
    const canonicalHost = getHostname(page.canonicalUrl);
    const siteHost = getHostname(`https://${ctx.dataset.domain}`);

    if (canonicalHost && siteHost && !isSameSite(page.canonicalUrl, ctx.dataset.domain)) {
      out.push(
        draft('CANONICAL_CROSS_DOMAIN', {
          url: page.url,
          description: `The canonical points to a different domain: ${page.canonicalUrl}`,
          recommendation:
            'Cross-domain canonicals hand ranking signals to another site. Unless this is deliberate syndication, point the canonical at this domain.',
          evidence: { canonical: page.canonicalUrl },
          impactMultiplier: importance,
        }, websiteId),
      );
    } else if (canonicalNormalized && canonicalNormalized !== page.normalizedUrl) {
      const target = ctx.byNormalized.get(canonicalNormalized);
      if (target) {
        const targetStatus = target.statusCode ?? 0;
        if (targetStatus >= 400 || targetStatus === 0) {
          out.push(
            draft('CANONICAL_TO_404', {
              url: page.url,
              description: `The canonical points to ${page.canonicalUrl}, which returns ${targetStatus || 'no response'}.`,
              recommendation: 'Point the canonical at a live, indexable URL.',
              evidence: { canonical: page.canonicalUrl, targetStatus },
              impactMultiplier: importance,
            }, websiteId),
          );
        } else if (targetStatus >= 300 && targetStatus < 400) {
          out.push(
            draft('CANONICAL_TO_REDIRECT', {
              url: page.url,
              description: `The canonical points to ${page.canonicalUrl}, which itself redirects.`,
              recommendation: 'Name the final destination URL in the canonical.',
              evidence: { canonical: page.canonicalUrl, redirectTarget: target.redirectTarget },
              impactMultiplier: importance,
            }, websiteId),
          );
        } else if (!target.isIndexable) {
          out.push(
            draft('CANONICAL_TO_NON_INDEXABLE', {
              url: page.url,
              description: `The canonical points to ${page.canonicalUrl}, which is not indexable (${target.indexabilityReason ?? 'unknown reason'}).`,
              recommendation: 'Consolidating into a non-indexable page discards the signals. Point the canonical at an indexable URL.',
              evidence: { canonical: page.canonicalUrl, reason: target.indexabilityReason },
              impactMultiplier: importance,
            }, websiteId),
          );
        }
      }
      if (ctx.dataset.robots.disallowedUrls.includes(canonicalNormalized)) {
        out.push(
          draft('BLOCKED_BUT_CANONICAL_TARGET', {
            url: page.url,
            description: `The canonical target ${page.canonicalUrl} is disallowed by robots.txt.`,
            recommendation: 'Allow the canonical target in robots.txt — a blocked URL cannot be fetched to honour the canonical.',
            evidence: { canonical: page.canonicalUrl },
            impactMultiplier: importance,
          }, websiteId),
        );
      }
    }
  }

  if (page.inSitemap && !page.isIndexable) {
    out.push(
      draft('NOINDEX_IN_SITEMAP', {
        url: page.url,
        description: `This URL is listed in the sitemap but is not indexable (${page.indexabilityReason ?? 'unknown reason'}).`,
        recommendation: 'Remove non-indexable URLs from the sitemap, or make the URL indexable.',
        evidence: { reason: page.indexabilityReason },
        impactMultiplier: importance * 0.8,
      }, websiteId),
    );
  }

  return out;
}

function auditMetadata(page: AuditPage, ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const status = page.statusCode ?? 0;
  if (status < 200 || status >= 300) return out;
  const importance = pageImportance(page, ctx);
  const t = SEO_THRESHOLDS;

  const title = page.title?.trim() ?? '';
  if (!title) {
    out.push(
      draft('MISSING_TITLE', {
        url: page.url,
        description: 'This page has no title tag.',
        recommendation: 'Write a unique 30-60 character title that leads with the page\'s primary topic.',
        evidence: {},
        impactMultiplier: importance,
      }, websiteId),
    );
  } else if (title.length > t.title.max) {
    out.push(
      draft('TITLE_TOO_LONG', {
        url: page.url,
        description: `The title is ${title.length} characters and will be truncated in results.`,
        recommendation: `Shorten to under ${t.title.max} characters, keeping the differentiating words first.`,
        evidence: { title, length: title.length },
        impactMultiplier: importance * 0.6,
        severityOverride: title.length > t.title.hardMax ? 'MEDIUM' : 'LOW',
      }, websiteId),
    );
  } else if (title.length < t.title.min) {
    out.push(
      draft('TITLE_TOO_SHORT', {
        url: page.url,
        description: `The title is only ${title.length} characters.`,
        recommendation: `Expand toward ${t.title.min}-${t.title.max} characters with the primary keyword and a qualifier.`,
        evidence: { title, length: title.length },
        impactMultiplier: importance * 0.5,
      }, websiteId),
    );
  }

  const desc = page.metaDescription?.trim() ?? '';
  if (!desc) {
    out.push(
      draft('MISSING_META_DESCRIPTION', {
        url: page.url,
        description: 'This page has no meta description.',
        recommendation: `Write a ${t.metaDescription.min}-${t.metaDescription.max} character summary that states the value of clicking through.`,
        evidence: {},
        impactMultiplier: importance * 0.7,
      }, websiteId),
    );
  } else if (desc.length > t.metaDescription.max) {
    out.push(
      draft('META_DESCRIPTION_TOO_LONG', {
        url: page.url,
        description: `The meta description is ${desc.length} characters and will be truncated.`,
        recommendation: `Trim to under ${t.metaDescription.max} characters.`,
        evidence: { length: desc.length },
        impactMultiplier: importance * 0.4,
      }, websiteId),
    );
  } else if (desc.length < t.metaDescription.min) {
    out.push(
      draft('META_DESCRIPTION_TOO_SHORT', {
        url: page.url,
        description: `The meta description is only ${desc.length} characters.`,
        recommendation: 'Use the available space to make the click worthwhile.',
        evidence: { length: desc.length },
        impactMultiplier: importance * 0.35,
      }, websiteId),
    );
  }

  if (page.h1.length === 0) {
    out.push(
      draft('MISSING_H1', {
        url: page.url,
        description: 'This page has no H1 heading.',
        recommendation: 'Add a single H1 that states the page topic in the reader\'s language.',
        evidence: {},
        impactMultiplier: importance * 0.8,
      }, websiteId),
    );
  } else if (page.h1.length > 1) {
    out.push(
      draft('MULTIPLE_H1', {
        url: page.url,
        description: `This page has ${page.h1.length} H1 headings.`,
        recommendation: 'Keep one H1 for the page topic and demote the rest to H2.',
        evidence: { h1: page.h1.slice(0, 5) },
        impactMultiplier: importance * 0.4,
        confidence: 0.7,
      }, websiteId),
    );
  }

  // Heading hierarchy: flag a jump of more than one level (H2 → H4).
  let previousLevel = 0;
  for (const heading of page.headings) {
    if (previousLevel > 0 && heading.level > previousLevel + 1) {
      out.push(
        draft('HEADING_HIERARCHY_SKIP', {
          url: page.url,
          description: `Heading levels jump from H${previousLevel} to H${heading.level} ("${truncate(heading.text, 60)}").`,
          recommendation: 'Use consecutive heading levels so the document outline is parseable and accessible.',
          evidence: { from: previousLevel, to: heading.level, heading: heading.text },
          impactMultiplier: importance * 0.2,
          confidence: 0.8,
        }, websiteId),
      );
      break; // one finding per page is enough
    }
    previousLevel = heading.level;
  }

  if (!page.metaViewport) {
    out.push(
      draft('MISSING_VIEWPORT', {
        url: page.url,
        description: 'This page has no viewport meta tag.',
        recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> — mobile is the primary index.',
        evidence: {},
        impactMultiplier: importance,
      }, websiteId),
    );
  }

  if (!page.lang) {
    out.push(
      draft('MISSING_LANG', {
        url: page.url,
        description: 'The <html> element has no lang attribute.',
        recommendation: 'Declare the content language, e.g. <html lang="en">.',
        evidence: {},
        impactMultiplier: importance * 0.4,
      }, websiteId),
    );
  }

  return out;
}

function auditContent(page: AuditPage, ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const status = page.statusCode ?? 0;
  if (status < 200 || status >= 300) return out;
  const importance = pageImportance(page, ctx);
  const thinThreshold = ctx.dataset.settings.thinContentWords;

  if (page.isIndexable && page.wordCount < thinThreshold) {
    out.push(
      draft('THIN_CONTENT', {
        url: page.url,
        description: `This indexable page has only ${page.wordCount} words of body copy (threshold ${thinThreshold}).`,
        recommendation:
          page.wordCount < 50
            ? 'This page is effectively empty. Either build it out, consolidate it into a stronger page, or set it to noindex.'
            : 'Expand with the specifics a reader actually needs, or merge it into a more complete page.',
        evidence: { wordCount: page.wordCount, threshold: thinThreshold },
        impactMultiplier: importance,
        severityOverride: page.wordCount < 50 ? 'HIGH' : 'MEDIUM',
        confidence: 0.75,
      }, websiteId),
    );
  }

  if (page.imagesMissingAlt > 0) {
    out.push(
      draft('MISSING_IMAGE_ALT', {
        url: page.url,
        description: `${page.imagesMissingAlt} of ${page.images.length} images have no alt text.`,
        recommendation: 'Describe each meaningful image; use alt="" only for purely decorative ones.',
        evidence: {
          missing: page.imagesMissingAlt,
          total: page.images.length,
          examples: page.images.filter((i) => !i.alt).slice(0, 5).map((i) => i.src),
        },
        impactMultiplier: importance * 0.5,
      }, websiteId),
    );
  }

  const outbound = ctx.outboundCounts.get(page.normalizedUrl) ?? 0;
  if (outbound > 300) {
    out.push(
      draft('EXCESSIVE_OUTBOUND_LINKS', {
        url: page.url,
        description: `This page contains ${outbound} internal links.`,
        recommendation: 'Trim navigation and body links so the important destinations receive a meaningful share of equity.',
        evidence: { internalLinks: outbound },
        impactMultiplier: importance * 0.3,
        confidence: 0.6,
      }, websiteId),
    );
  }

  return out;
}

function auditStructuredData(page: AuditPage, ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const status = page.statusCode ?? 0;
  if (status < 200 || status >= 300) return out;
  const importance = pageImportance(page, ctx);

  const malformed = page.structuredData.filter(
    (block): block is { __error: string } =>
      typeof block === 'object' && block !== null && '__error' in (block as Record<string, unknown>),
  );
  if (malformed.length > 0) {
    out.push(
      draft('MALFORMED_STRUCTURED_DATA', {
        url: page.url,
        description: `${malformed.length} JSON-LD block(s) on this page could not be parsed.`,
        recommendation: 'Fix the JSON syntax — invalid blocks are discarded entirely, so the markup currently does nothing.',
        evidence: { errors: malformed.map((m) => m.__error).slice(0, 3) },
        impactMultiplier: importance,
      }, websiteId),
    );
  }

  if (page.isIndexable && page.schemaTypes.length === 0 && page.wordCount > 200) {
    out.push(
      draft('MISSING_STRUCTURED_DATA', {
        url: page.url,
        description: 'This page has no structured data.',
        recommendation:
          'Add the schema type that matches the page (Article, Product, FAQPage, SoftwareApplication…) so machines can read its entities.',
        evidence: { wordCount: page.wordCount },
        impactMultiplier: importance * 0.5,
        confidence: 0.8,
      }, websiteId),
    );
  }

  if (page.isIndexable && page.depth >= 2 && !page.schemaTypes.includes('BreadcrumbList')) {
    out.push(
      draft('MISSING_BREADCRUMBS', {
        url: page.url,
        description: 'This page sits below the top level but has no BreadcrumbList markup.',
        recommendation: 'Add BreadcrumbList JSON-LD reflecting the real navigation path.',
        evidence: { depth: page.depth },
        impactMultiplier: importance * 0.3,
        confidence: 0.7,
      }, websiteId),
    );
  }

  return out;
}

function auditSecurity(page: AuditPage, ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  if (ctx.dataset.protocol !== 'https') return out;
  if (!page.url.startsWith('https://')) return out;
  const importance = pageImportance(page, ctx);

  const insecureImages = page.images.filter((i) => i.src.startsWith('http://'));
  if (insecureImages.length > 0) {
    out.push(
      draft('MIXED_CONTENT', {
        url: page.url,
        description: `${insecureImages.length} sub-resource(s) are loaded over plain HTTP on an HTTPS page.`,
        recommendation: 'Serve every asset over HTTPS — browsers block or downgrade insecure sub-resources.',
        evidence: { examples: insecureImages.slice(0, 5).map((i) => i.src) },
        impactMultiplier: importance,
      }, websiteId),
    );
  }

  const insecureLinks = page.links.filter((l) => l.isInternal && l.href.startsWith('http://'));
  if (insecureLinks.length > 0) {
    out.push(
      draft('HTTP_LINK_ON_HTTPS', {
        url: page.url,
        description: `${insecureLinks.length} internal link(s) use http:// on an HTTPS site.`,
        recommendation: 'Update the links to https:// so readers and crawlers skip the extra redirect.',
        evidence: { examples: insecureLinks.slice(0, 5).map((l) => l.href) },
        impactMultiplier: importance * 0.4,
      }, websiteId),
    );
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Site-level rules
// ─────────────────────────────────────────────────────────────────────────────

function groupDuplicates<T>(items: T[], keyFn: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  for (const [key, list] of groups) if (list.length < 2) groups.delete(key);
  return groups;
}

function auditDuplicates(ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const indexable = ctx.dataset.pages.filter(
    (p) => p.isIndexable && (p.statusCode ?? 0) >= 200 && (p.statusCode ?? 0) < 300,
  );

  for (const [title, pages] of groupDuplicates(indexable, (p) => p.title?.trim().toLowerCase() || null)) {
    out.push(
      draft('DUPLICATE_TITLE', {
        url: pages[0]!.url,
        key: title,
        description: `${pages.length} pages share the title "${truncate(pages[0]!.title ?? '', 70)}".`,
        recommendation: 'Give each page a title that names what makes it different, or consolidate the pages if they cover the same topic.',
        evidence: { count: pages.length, urls: pages.slice(0, 10).map((p) => p.url), title: pages[0]!.title },
        impactMultiplier: Math.min(1, 0.4 + pages.length * 0.06),
      }, websiteId),
    );
  }

  for (const [desc, pages] of groupDuplicates(indexable, (p) => p.metaDescription?.trim().toLowerCase() || null)) {
    out.push(
      draft('DUPLICATE_META_DESCRIPTION', {
        url: pages[0]!.url,
        key: desc.slice(0, 60),
        description: `${pages.length} pages share the same meta description.`,
        recommendation: 'Write a distinct description per page; templated descriptions rarely earn the click.',
        evidence: { count: pages.length, urls: pages.slice(0, 10).map((p) => p.url) },
        impactMultiplier: Math.min(1, 0.3 + pages.length * 0.04),
      }, websiteId),
    );
  }

  for (const [h1, pages] of groupDuplicates(indexable, (p) => p.h1[0]?.trim().toLowerCase() || null)) {
    if (pages.length < 3) continue; // two pages sharing an H1 is common and rarely actionable
    out.push(
      draft('DUPLICATE_H1', {
        url: pages[0]!.url,
        key: h1.slice(0, 60),
        description: `${pages.length} pages share the H1 "${truncate(pages[0]!.h1[0] ?? '', 70)}".`,
        recommendation: 'Differentiate the headings, or consolidate pages that genuinely cover the same topic.',
        evidence: { count: pages.length, urls: pages.slice(0, 10).map((p) => p.url) },
        impactMultiplier: Math.min(1, 0.3 + pages.length * 0.04),
      }, websiteId),
    );
  }

  // Exact duplicate bodies
  for (const [hash, pages] of groupDuplicates(indexable, (p) => (p.wordCount > 100 ? p.contentHash : null))) {
    out.push(
      draft('DUPLICATE_CONTENT', {
        url: pages[0]!.url,
        key: hash.slice(0, 16),
        description: `${pages.length} pages have byte-identical body content.`,
        recommendation:
          'Pick one canonical URL and either redirect, canonicalise or differentiate the others. Identical bodies force the engine to choose for you.',
        evidence: { count: pages.length, urls: pages.slice(0, 10).map((p) => p.url) },
        impactMultiplier: Math.min(1, 0.5 + pages.length * 0.08),
      }, websiteId),
    );
  }

  // Near-duplicates via simhash. O(n²) is fine below a few thousand pages; above that we sample
  // the largest pages, which is where near-duplication actually costs rankings.
  const candidates = indexable
    .filter((p) => p.simhash && p.wordCount > 200)
    .sort((a, b) => b.wordCount - a.wordCount)
    .slice(0, 2000);
  const reportedNearDupes = new Set<string>();
  const exactHashes = new Set(
    [...groupDuplicates(indexable, (p) => (p.wordCount > 100 ? p.contentHash : null))].map(([h]) => h),
  );
  for (let i = 0; i < candidates.length; i++) {
    const a = candidates[i]!;
    if (reportedNearDupes.has(a.normalizedUrl)) continue;
    const matches: AuditPage[] = [];
    for (let j = i + 1; j < candidates.length; j++) {
      const b = candidates[j]!;
      if (reportedNearDupes.has(b.normalizedUrl)) continue;
      if (a.contentHash && a.contentHash === b.contentHash) continue; // already reported as exact
      const distance = simhashDistance(a.simhash!, b.simhash!);
      if (distance <= SEO_THRESHOLDS.duplicateSimhashDistance) matches.push(b);
      if (matches.length >= 10) break;
    }
    if (matches.length > 0) {
      if (a.contentHash && exactHashes.has(a.contentHash)) continue;
      reportedNearDupes.add(a.normalizedUrl);
      for (const m of matches) reportedNearDupes.add(m.normalizedUrl);
      out.push(
        draft('NEAR_DUPLICATE_CONTENT', {
          url: a.url,
          key: a.simhash!.slice(0, 12),
          description: `This page is near-identical to ${matches.length} other page(s) on the site.`,
          recommendation:
            'Differentiate the content substantially, or consolidate into one stronger page with a redirect from the rest.',
          evidence: { similarUrls: matches.slice(0, 10).map((m) => m.url), wordCount: a.wordCount },
          impactMultiplier: 0.6,
          confidence: 0.75,
        }, websiteId),
      );
    }
  }

  return out;
}

function auditArchitecture(ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const { dataset, inboundCounts } = ctx;
  const homepageNormalized = normalizeUrl(`${dataset.protocol}://${dataset.domain}/`);

  for (const page of dataset.pages) {
    const status = page.statusCode ?? 0;
    if (status < 200 || status >= 300 || !page.isIndexable) continue;
    if (page.normalizedUrl === homepageNormalized) continue;

    const inbound = inboundCounts.get(page.normalizedUrl) ?? 0;
    if (inbound === 0) {
      out.push(
        draft('ORPHAN_PAGE', {
          url: page.url,
          description: page.inSitemap
            ? 'No internal link points to this page — it is only discoverable through the sitemap.'
            : 'No internal link points to this page.',
          recommendation:
            'Link to it from relevant existing pages. The internal-link engine can suggest specific source pages and anchors.',
          evidence: { inSitemap: page.inSitemap, depth: page.depth, wordCount: page.wordCount },
          impactMultiplier: page.wordCount > 300 ? 0.9 : 0.5,
        }, websiteId),
      );
    } else if (inbound < SEO_THRESHOLDS.internalLinksIn.lowThreshold && page.wordCount > 300) {
      out.push(
        draft('LOW_INTERNAL_LINKS', {
          url: page.url,
          description: `Only ${inbound} internal link(s) point to this page.`,
          recommendation: 'Add contextual links from related pages so the page reads as important to crawlers.',
          evidence: { inboundLinks: inbound },
          impactMultiplier: 0.4,
        }, websiteId),
      );
    }

    if (page.depth > dataset.settings.maxDepthWarn) {
      out.push(
        draft('DEEP_PAGE', {
          url: page.url,
          description: `This page is ${page.depth} clicks from the homepage.`,
          recommendation: 'Flatten the path with hub pages or contextual links from higher-level pages.',
          evidence: { depth: page.depth },
          impactMultiplier: Math.min(1, 0.3 + (page.depth - dataset.settings.maxDepthWarn) * 0.15),
          severityOverride: page.depth > SEO_THRESHOLDS.crawlDepth.critical ? 'MEDIUM' : 'LOW',
        }, websiteId),
      );
    }
  }

  // Isolated clusters: connected components (undirected) of the internal link graph that do not
  // contain the homepage. These groups cannot exchange equity with the rest of the site.
  const adjacency = new Map<string, Set<string>>();
  const ensure = (u: string) => {
    let s = adjacency.get(u);
    if (!s) { s = new Set(); adjacency.set(u, s); }
    return s;
  };
  for (const page of dataset.pages) ensure(page.normalizedUrl);
  for (const edge of dataset.edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    ensure(edge.from).add(edge.to);
    ensure(edge.to).add(edge.from);
  }
  const seen = new Set<string>();
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const component: string[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const node = stack.pop()!;
      component.push(node);
      for (const neighbour of adjacency.get(node) ?? []) {
        if (!seen.has(neighbour)) { seen.add(neighbour); stack.push(neighbour); }
      }
    }
    if (component.length >= 3 && !component.includes(homepageNormalized ?? '')) {
      const pages = component
        .map((u) => ctx.byNormalized.get(u))
        .filter((p): p is AuditPage => Boolean(p) && p!.isIndexable);
      if (pages.length >= 3) {
        out.push(
          draft('ISOLATED_CLUSTER', {
            url: pages[0]!.url,
            key: `component:${pages.length}:${pages[0]!.normalizedUrl}`,
            description: `${pages.length} pages form a group that is not reachable from the main site structure by internal links.`,
            recommendation: 'Link this cluster to and from the main navigation or a relevant hub page.',
            evidence: { size: pages.length, urls: pages.slice(0, 10).map((p) => p.url) },
            impactMultiplier: Math.min(1, 0.4 + pages.length * 0.03),
            confidence: 0.7,
          }, websiteId),
        );
      }
    }
  }

  return out;
}

function auditLinks(ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const { dataset, byNormalized } = ctx;

  // Group broken/redirecting targets so we report one finding per source page.
  const brokenBySource = new Map<string, Array<{ target: string; status: number }>>();
  const redirectBySource = new Map<string, Array<{ target: string; finalUrl: string | null }>>();
  const noindexBySource = new Map<string, string[]>();

  for (const edge of dataset.edges) {
    const target = byNormalized.get(edge.to);
    if (!target) continue; // never crawled (limit reached) — cannot claim it is broken
    const status = target.statusCode ?? 0;
    if (status >= 400 || (status === 0 && target.error)) {
      const list = brokenBySource.get(edge.from) ?? [];
      list.push({ target: target.url, status });
      brokenBySource.set(edge.from, list);
    } else if (status >= 300 && status < 400) {
      const list = redirectBySource.get(edge.from) ?? [];
      list.push({ target: target.url, finalUrl: target.redirectTarget });
      redirectBySource.set(edge.from, list);
    } else if (!target.isIndexable) {
      const list = noindexBySource.get(edge.from) ?? [];
      list.push(target.url);
      noindexBySource.set(edge.from, list);
    }
  }

  for (const [source, targets] of brokenBySource) {
    const page = byNormalized.get(source);
    out.push(
      draft('BROKEN_INTERNAL_LINK', {
        url: page?.url ?? source,
        description: `This page links to ${targets.length} internal URL(s) that return an error.`,
        recommendation: 'Update the links to the correct destination, or restore/redirect the broken URLs.',
        evidence: { count: targets.length, targets: targets.slice(0, 10) },
        impactMultiplier: Math.min(1, 0.4 + targets.length * 0.05),
      }, websiteId),
    );
  }

  for (const [source, targets] of redirectBySource) {
    if (targets.length < 2) continue; // a single redirected link is noise
    const page = byNormalized.get(source);
    out.push(
      draft('INTERNAL_LINK_TO_REDIRECT', {
        url: page?.url ?? source,
        description: `This page links to ${targets.length} internal URL(s) that redirect.`,
        recommendation: 'Point the links straight at the final destination to remove a hop for every visitor and crawler.',
        evidence: { count: targets.length, targets: targets.slice(0, 10) },
        impactMultiplier: Math.min(1, 0.3 + targets.length * 0.03),
      }, websiteId),
    );
  }

  for (const [source, targets] of noindexBySource) {
    if (targets.length < 3) continue;
    const page = byNormalized.get(source);
    out.push(
      draft('INTERNAL_LINK_TO_NOINDEX', {
        url: page?.url ?? source,
        description: `This page links to ${targets.length} non-indexable pages.`,
        recommendation: 'Reduce links into noindex pages so more equity flows to pages that can rank.',
        evidence: { count: targets.length, targets: targets.slice(0, 10) },
        impactMultiplier: 0.25,
        confidence: 0.65,
      }, websiteId),
    );
  }

  return out;
}

function auditSiteWide(ctx: RuleContext, websiteId: string): IssueDraft[] {
  const out: IssueDraft[] = [];
  const { dataset } = ctx;
  const siteUrl = `${dataset.protocol}://${dataset.domain}`;

  if (!dataset.robots.found) {
    out.push(
      draft('MISSING_ROBOTS_TXT', {
        url: `${siteUrl}/robots.txt`,
        description: 'No robots.txt was found at the site root.',
        recommendation: 'Publish a robots.txt that allows crawling and points to your XML sitemap.',
        evidence: {},
        impactMultiplier: 0.4,
      }, websiteId),
    );
  }

  if (dataset.robots.disallowedUrls.length > 0) {
    const linked = dataset.robots.disallowedUrls.filter((u) => (ctx.inboundCounts.get(u) ?? 0) > 0);
    if (linked.length > 0) {
      out.push(
        draft('ROBOTS_BLOCKS_IMPORTANT', {
          url: `${siteUrl}/robots.txt`,
          description: `${linked.length} internally linked URL(s) are disallowed by robots.txt.`,
          recommendation:
            'Review the Disallow rules. Pages you link to internally are usually pages you want crawled.',
          evidence: { count: linked.length, examples: linked.slice(0, 10) },
          impactMultiplier: Math.min(1, 0.4 + linked.length * 0.03),
        }, websiteId),
      );
    }
  }

  if (!dataset.sitemap.found) {
    out.push(
      draft('MISSING_SITEMAP', {
        url: `${siteUrl}/sitemap.xml`,
        description: 'No XML sitemap could be found via robots.txt or the conventional locations.',
        recommendation: 'Publish an XML sitemap of your canonical, indexable URLs and reference it from robots.txt.',
        evidence: { checked: ['robots.txt Sitemap directive', '/sitemap.xml', '/sitemap_index.xml'] },
        impactMultiplier: 0.7,
      }, websiteId),
    );
  }

  for (const error of dataset.sitemap.errors.slice(0, 5)) {
    out.push(
      draft('SITEMAP_ERROR', {
        url: `${siteUrl}/sitemap.xml`,
        key: error.slice(0, 80),
        description: `A sitemap could not be processed: ${error}`,
        recommendation: 'Fix the sitemap so it is valid XML and under the 50 MB / 50,000 URL limits.',
        evidence: { error },
        impactMultiplier: 0.8,
      }, websiteId),
    );
  }

  // Sitemap URLs that no internal link reaches, and sitemap URLs that are broken.
  const sitemapNormalized = new Set(
    dataset.sitemap.urls.map((u) => normalizeUrl(u)).filter((u): u is string => Boolean(u)),
  );
  const brokenSitemapUrls: string[] = [];
  const orphanSitemapUrls: string[] = [];
  for (const normalized of sitemapNormalized) {
    const page = ctx.byNormalized.get(normalized);
    if (!page) continue;
    const status = page.statusCode ?? 0;
    if (status >= 400 || status === 0) brokenSitemapUrls.push(page.url);
    else if ((ctx.inboundCounts.get(normalized) ?? 0) === 0) orphanSitemapUrls.push(page.url);
  }

  if (brokenSitemapUrls.length > 0) {
    out.push(
      draft('SITEMAP_BROKEN_URL', {
        url: `${siteUrl}/sitemap.xml`,
        description: `The sitemap lists ${brokenSitemapUrls.length} URL(s) that return an error.`,
        recommendation: 'Regenerate the sitemap so it contains only live, canonical, indexable URLs.',
        evidence: { count: brokenSitemapUrls.length, examples: brokenSitemapUrls.slice(0, 10) },
        impactMultiplier: Math.min(1, 0.4 + brokenSitemapUrls.length * 0.02),
      }, websiteId),
    );
  }

  if (orphanSitemapUrls.length > 0) {
    out.push(
      draft('SITEMAP_ORPHAN_URL', {
        url: `${siteUrl}/sitemap.xml`,
        description: `${orphanSitemapUrls.length} sitemap URL(s) have no internal links pointing to them.`,
        recommendation: 'Sitemaps help discovery but pass no equity. Link these pages from relevant content.',
        evidence: { count: orphanSitemapUrls.length, examples: orphanSitemapUrls.slice(0, 10) },
        impactMultiplier: Math.min(1, 0.3 + orphanSitemapUrls.length * 0.02),
      }, websiteId),
    );
  }

  // Organization schema anywhere on the site (a GEO prerequisite).
  const hasOrganization = dataset.pages.some(
    (p) => p.schemaTypes.includes('Organization') || p.schemaTypes.includes('LocalBusiness'),
  );
  if (!hasOrganization && dataset.pages.length > 0) {
    out.push(
      draft('MISSING_ORGANIZATION_SCHEMA', {
        url: siteUrl,
        description: 'No Organization (or LocalBusiness) structured data was found anywhere on the site.',
        recommendation:
          'Add Organization JSON-LD on the homepage with name, url, logo and sameAs profiles. This is the anchor entity answer engines resolve your brand against.',
        evidence: { pagesChecked: dataset.pages.length },
        impactMultiplier: 0.8,
      }, websiteId),
    );
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────

export interface AuditResult {
  issues: IssueDraft[];
  stats: {
    pagesAudited: number;
    indexablePages: number;
    orphanPages: number;
    brokenPages: number;
    issuesBySeverity: Record<string, number>;
    issuesByCategory: Record<string, number>;
  };
}

/**
 * Run the full deterministic technical audit over a crawl dataset.
 *
 * Pure: no database access, no network. The worker persists the resulting drafts as
 * TechnicalIssue rows, reconciling by fingerprint so repeat findings update rather than duplicate.
 */
export function runTechnicalAudit(dataset: AuditDataset): AuditResult {
  const ctx = buildContext(dataset);
  const websiteId = dataset.websiteId;
  const issues: IssueDraft[] = [];

  for (const page of dataset.pages) {
    issues.push(...auditStatus(page, ctx, websiteId));
    issues.push(...auditIndexability(page, ctx, websiteId));
    issues.push(...auditMetadata(page, ctx, websiteId));
    issues.push(...auditContent(page, ctx, websiteId));
    issues.push(...auditStructuredData(page, ctx, websiteId));
    issues.push(...auditSecurity(page, ctx, websiteId));
  }

  issues.push(...auditDuplicates(ctx, websiteId));
  issues.push(...auditArchitecture(ctx, websiteId));
  issues.push(...auditLinks(ctx, websiteId));
  issues.push(...auditSiteWide(ctx, websiteId));

  // Deduplicate by fingerprint — a URL can legitimately trip the same rule twice
  // (e.g. two canonical problems); keep the highest-impact instance.
  const byFingerprint = new Map<string, IssueDraft>();
  for (const issue of issues) {
    const existing = byFingerprint.get(issue.fingerprint);
    if (!existing || issue.estimatedImpact > existing.estimatedImpact) {
      byFingerprint.set(issue.fingerprint, issue);
    }
  }
  const deduped = [...byFingerprint.values()];

  const issuesBySeverity: Record<string, number> = {};
  const issuesByCategory: Record<string, number> = {};
  for (const issue of deduped) {
    issuesBySeverity[issue.severity] = (issuesBySeverity[issue.severity] ?? 0) + 1;
    issuesByCategory[issue.category] = (issuesByCategory[issue.category] ?? 0) + 1;
  }

  const homepageNormalized = normalizeUrl(`${dataset.protocol}://${dataset.domain}/`);
  return {
    issues: deduped,
    stats: {
      pagesAudited: dataset.pages.length,
      indexablePages: dataset.pages.filter((p) => p.isIndexable && (p.statusCode ?? 0) < 300).length,
      orphanPages: dataset.pages.filter(
        (p) =>
          p.isIndexable &&
          p.normalizedUrl !== homepageNormalized &&
          (ctx.inboundCounts.get(p.normalizedUrl) ?? 0) === 0,
      ).length,
      brokenPages: dataset.pages.filter((p) => (p.statusCode ?? 0) >= 400 || (p.statusCode === null && p.error)).length,
      issuesBySeverity,
      issuesByCategory,
    },
  };
}
