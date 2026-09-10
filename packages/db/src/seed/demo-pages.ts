import type { PageType } from '@prisma/client';
import { countWords, normalizeUrl, tokenize, toAbsolute, urlDepth, type DiscoveredLink, type HeadingNode, type ImageInfo } from '@seo/shared';
import { contentHash, simhash } from '@seo/shared/hash';
import type { AuditDataset, AuditPage } from '@seo/seo-engine';
import type { DemoPageBlueprint, DemoSiteBlueprint } from './demo-sites';
import { Rng } from './rng';

/**
 * Turns a site blueprint into the exact shape a finished crawl produces.
 *
 * The point of going through `AuditPage` rather than writing issue rows directly is that the demo
 * findings are then produced by the same rule engine that runs in production: if a rule changes,
 * the demo data changes with it, and a demo issue can never describe a defect the page does not
 * actually have.
 */

export interface DemoPage extends AuditPage {
  path: string;
  pageType: PageType;
  targetKeywords: string[];
  publishedAt: Date | null;
  contentUpdatedAt: Date | null;
  metaTitle: string | null;
  externalLinkCount: number;
  imageCount: number;
  internalLinkCount: number;
}

export interface DemoEdge {
  fromPath: string;
  toPath: string;
  fromUrl: string;
  toUrl: string;
  anchorText: string;
  inNav: boolean;
  inFooter: boolean;
  inMainContent: boolean;
  position: number;
}

export interface DemoCrawl {
  dataset: AuditDataset;
  pages: DemoPage[];
  byPath: Map<string, DemoPage>;
  edges: DemoEdge[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Prose. Deliberately generic editorial sentences parameterised by topic, so the
// bodies read like real copy without pretending to be expert advice about anything.
// ─────────────────────────────────────────────────────────────────────────────

const INTROS = [
  'This page covers {topic} in the order the decisions actually have to be made.',
  'Most {readers} arrive at {topic} after something has already gone wrong, which is a slow way to learn it.',
  '{Topic} looks like a small detail until the first time it is wrong at scale.',
  'The useful question about {topic} is not which option is best, but which number you are trying to move.',
  'What follows is how {brand} approaches {topic}, including the parts that are still awkward.',
  'There is a lot written about {topic}, and most of it skips the step where you have to choose.',
];

const DEFINITIONS = [
  '{Topic} refers to the work of deciding in advance, so the question about {term} is already answered when the moment arrives.',
  '{Topic} is defined as the gap between what the data shows today and the choice you have to make tomorrow.',
  'In plain terms, {topic} is a method for turning what already happened into a defensible estimate of what happens next.',
  '{Topic} is the set of rules that turn {term} observations into a decision you can defend to someone else.',
];

const BODY = [
  // Every template carries at least one page-specific slot ({topic}, {section} or {term}).
  // That is not decoration: SimHash includes stop words, so prose written in one voice with no
  // per-page vocabulary collides across pages and the near-duplicate rule fires on documents that
  // are merely generic. Real pages diverge because their nouns diverge; these have to as well.
  'When {term} is involved the trade-off is straightforward: more {a} buys you less {b}, and you pay for it in {c}.',
  'Start with {section}, because {term} is cheap to get right and expensive to retrofit.',
  '{Section} is where most of the avoidable cost sits, usually because {term} is nobody\'s job in particular.',
  'Two things go wrong with {term} here, and only one of them is obvious at the time.',
  'The first pass at {term} does not have to be sophisticated; it has to be written down and repeatable.',
  'A rule about {term} you can explain in one sentence will outperform a model nobody trusts enough to follow.',
  'It is worth separating the measurement of {term} from the judgement about it — they fail for different reasons.',
  'Review {term} quarterly rather than continuously, or you will spend more time tuning it than deciding anything.',
  'When the data behind {term} is noisy, widen the interval rather than pretending to a precision you do not have.',
  'Write down the assumption behind {term} before you need it, so the disagreement happens early instead of in the postmortem.',
  '{Section} rewards consistency more than cleverness, and {term} is where that shows up first.',
  'The failure mode nobody plans for is the one where {term} works and nobody acts on the output.',
  'Keep the list of exceptions around {term} short. Every exception is a rule somebody has to remember later.',
  'If two people reach different conclusions about {term} from the same inputs, the process is not finished.',
  'Document what would change your mind about {term}; it is the fastest way to keep the argument honest.',
  'The routine around {term} that survives contact with a busy week is the one worth building.',
  'Most of what goes wrong with {topic} goes wrong quietly, which is why {term} is usually found late.',
  'Treat {topic} as a decision you repeat rather than a project you finish.',
  'For {readers}, {topic} is usually constrained by whatever the underlying data will support.',
  '{Topic} is easier to defend when the inputs behind {term} sit next to the output.',
  'The hardest part of {section} is agreeing what "good" looks like for {term} before anything is measured.',
  'Anyone meeting {term} for the first time should expect the second attempt to be the useful one.',
  'Nothing about {section} is difficult in isolation; the difficulty is doing {term} every week.',
  'If {topic} is someone\'s side responsibility, assume the review of {term} gets skipped in a busy quarter.',
];

const DATA_SENTENCES = [
  'Our data across {n1} comparable setups working on {term} puts the typical improvement between {n2}% and {n3}%.',
  'We measured {n1} runs of this before publishing it, and the spread was wider than the average suggests.',
  'We found that {n2}% of the variance in {term} came from inputs nobody was reviewing week to week.',
  'In our own testing of {term} the difference showed up within {n4} weeks, and then flattened.',
];

const EXPERTISE_SENTENCES = [
  'Our team has worked on {term} at {n1} organisations, and the methodology below is what survived.',
  'The methodology behind {term} is written out in full so you can disagree with a specific step rather than the conclusion.',
  'This is reviewed by the people who do the work day to day, not only by the people who wrote it up.',
];

const COMPARISON_SENTENCES = [
  'Compared with the alternative, {topic} trades setup effort for predictability.',
  'Against a simpler approach, the difference in {term} only matters once volume passes the point where mistakes compound.',
  'The table below is the short version: the differences in {term} that change a decision, not every specification.',
];

const CLOSERS = [
  'If you take one thing from this page about {term}, make it the checklist above.',
  'The next step is small: pick one measure for {term}, write down the target, and review it in a month.',
  '{Cta}',
  'Questions about how {term} applies to your own setup are welcome — that is what the contact page is for.',
];

const ABSTRACT_A = ['accuracy', 'coverage', 'speed', 'detail', 'control'];
const ABSTRACT_B = ['flexibility', 'simplicity', 'margin for error', 'reaction time'];
const ABSTRACT_C = ['effort', 'maintenance', 'review time', 'complexity'];

interface ProseVars {
  topic: string;
  section: string;
  brand: string;
  readers: string;
  cta: string;
  /** Page-specific nouns, drawn from the topic, the section headings and the target keywords. */
  terms: string[];
  rng: Rng;
}

function capitalise(value: string): string {
  return value.length ? value[0].toUpperCase() + value.slice(1) : value;
}

function fill(template: string, vars: ProseVars): string {
  const { rng } = vars;
  return template
    .replace(/\{Topic\}/g, capitalise(vars.topic))
    .replace(/\{topic\}/g, vars.topic)
    .replace(/\{Section\}/g, capitalise(vars.section))
    .replace(/\{section\}/g, vars.section.toLowerCase())
    .replace(/\{brand\}/g, vars.brand)
    .replace(/\{readers\}/g, vars.readers)
    .replace(/\{Cta\}/g, vars.cta)
    .replace(/\{Term\}/g, () => capitalise(rng.pick(vars.terms)))
    .replace(/\{term\}/g, () => rng.pick(vars.terms))
    .replace(/\{a\}/g, rng.pick(ABSTRACT_A))
    .replace(/\{b\}/g, rng.pick(ABSTRACT_B))
    .replace(/\{c\}/g, rng.pick(ABSTRACT_C))
    .replace(/\{n1\}/g, String(rng.int(12, 180)))
    .replace(/\{n2\}/g, String(rng.int(11, 38)))
    .replace(/\{n3\}/g, String(rng.int(41, 72)))
    .replace(/\{n4\}/g, String(rng.int(3, 11)));
}

const WORD_TARGET_BY_QUALITY = { strong: 950, average: 620, weak: 190 } as const;

/**
 * The vocabulary that makes one page's copy distinguishable from another's: the topic itself, the
 * words in its section headings, and its target keywords.
 */
function pageTerms(bp: DemoPageBlueprint): string[] {
  const primary = bp.topic.replace(/^the\s+/i, '');
  // Section headings are used whole rather than tokenised: "the question about getting started"
  // reads like English, "the question about getting" does not, and a bare heading token is just as
  // likely to be a verb as a noun.
  const sections = bp.sections.map((section) => section.toLowerCase()).filter((section) => section.length > 4);
  // Repetition is deliberate: `Rng.pick` is uniform, so listing the page's own phrase several times
  // biases the copy toward it instead of toward a heading fragment.
  return [primary, primary, primary, ...(bp.targetKeywords ?? []), ...sections];
}

interface BuiltBody {
  text: string;
  headings: HeadingNode[];
}

/**
 * Build the body copy and heading outline for one page.
 *
 * `mentions` are target keywords of related pages this page does *not* link to — they exist so the
 * internal-link engine has a real phrase in real prose to attach a suggested link to, rather than
 * the seed inventing a placement that does not exist in the copy.
 */
function buildBody(bp: DemoPageBlueprint, site: DemoSiteBlueprint, rng: Rng, mentions: string[]): BuiltBody {
  const quality = bp.quality ?? 'average';
  const target = bp.words ?? WORD_TARGET_BY_QUALITY[quality];
  const headings: HeadingNode[] = [];
  const parts: string[] = [];

  const vars: ProseVars = {
    topic: bp.topic,
    section: bp.sections[0] ?? bp.topic,
    brand: site.brandName,
    readers: site.readerNoun,
    cta: site.knowledge.preferredCta,
    terms: pageTerms(bp),
    rng,
  };

  // Each page draws from its own half of the sentence pool. Without this, two pages built from the
  // same 24 templates end up within SimHash's near-duplicate threshold of each other purely
  // because they share sentence structure, and the audit reports duplication that is not there.
  const bodyPool = rng.sample(BODY, Math.ceil(BODY.length / 2));

  parts.push(fill(rng.pick(INTROS), vars));
  if (quality !== 'weak' || bp.pageType === 'GLOSSARY') {
    parts.push(fill(rng.pick(DEFINITIONS), vars));
  }
  if (quality === 'strong') {
    parts.push(fill(rng.pick(EXPERTISE_SENTENCES), vars));
  }

  bp.sections.forEach((section, index) => {
    headings.push({ level: 2, text: section });
    const sectionVars: ProseVars = { ...vars, section };
    // A crawler's extracted text includes heading text, so the body stream does too. It is also
    // the strongest source of per-page vocabulary, which keeps distinct pages lexically distinct.
    parts.push(`${section}.`);
    const sentenceCount = quality === 'weak' ? 2 : quality === 'strong' ? 5 : 3;
    for (let i = 0; i < sentenceCount; i++) parts.push(fill(rng.pick(bodyPool), sectionVars));

    if (quality === 'strong' && index === 0) {
      parts.push(fill(rng.pick(DATA_SENTENCES), sectionVars));
    }
    if (bp.pageType === 'COMPARISON' && index === 1) {
      parts.push(fill(rng.pick(COMPARISON_SENTENCES), sectionVars));
    }
    // A skipped level (H2 → H4) is a real accessibility defect, so it is modelled as one.
    if (bp.headingSkip && index === 1) {
      headings.push({ level: 4, text: `More on ${section.toLowerCase()}` });
      parts.push(fill(rng.pick(bodyPool), sectionVars));
    } else if (quality === 'strong' && index > 0) {
      headings.push({ level: 3, text: `In practice: ${section.toLowerCase()}` });
      parts.push(fill(rng.pick(bodyPool), sectionVars));
    }
  });

  for (const mention of mentions) {
    parts.push(`It is worth reading this alongside ${mention}, which covers the part this page skips.`);
  }

  // Pad to the target length with more body sentences rather than repeating a filler paragraph,
  // rotating through the page's own sections so the padding carries this page's vocabulary too.
  let words = countWords(parts.join(' '));
  for (let guard = 0; words < target && guard < 400; guard++) {
    const section = bp.sections.length > 0 ? bp.sections[guard % bp.sections.length] : vars.section;
    const sentence = fill(rng.pick(bodyPool), { ...vars, section });
    parts.push(sentence);
    words += countWords(sentence);
  }

  parts.push(fill(rng.pick(CLOSERS), vars));
  return { text: parts.join(' '), headings };
}

/** A near-duplicate: the same body with the opening and closing sentences swapped out. */
function makeNearDuplicate(baseText: string, bp: DemoPageBlueprint, site: DemoSiteBlueprint, rng: Rng): string {
  const vars: ProseVars = {
    topic: bp.topic,
    section: bp.sections[0] ?? bp.topic,
    brand: site.brandName,
    readers: site.readerNoun,
    cta: site.knowledge.preferredCta,
    terms: pageTerms(bp),
    rng,
  };
  const sentences = baseText.split(/(?<=\.)\s+/);
  if (sentences.length > 3) {
    sentences[0] = fill(rng.pick(INTROS), vars);
    sentences[sentences.length - 1] = fill(rng.pick(CLOSERS), vars);
  }
  return sentences.join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata
// ─────────────────────────────────────────────────────────────────────────────

function defaultTitle(bp: DemoPageBlueprint, site: DemoSiteBlueprint): string {
  const withBrand = `${capitalise(bp.topic)} | ${site.brandName}`;
  return withBrand.length <= 60 ? withBrand : capitalise(bp.topic);
}

function defaultMetaDescription(bp: DemoPageBlueprint, site: DemoSiteBlueprint): string {
  let description = `${capitalise(bp.topic)} explained for ${site.readerNoun}: what to measure, what to change first, and what it costs to get wrong.`;
  if (description.length > 155) {
    const cut = description.slice(0, 152);
    description = `${cut.slice(0, cut.lastIndexOf(' '))}.`;
  }
  return description;
}

function buildImages(bp: DemoPageBlueprint, url: string, rng: Rng): ImageInfo[] {
  const total = bp.images ?? 0;
  const missingAlt = Math.min(bp.imagesMissingAlt ?? 0, total);
  const insecure = Math.min(bp.insecureImages ?? 0, total);
  const images: ImageInfo[] = [];
  for (let i = 0; i < total; i++) {
    const protocol = i < insecure ? 'http' : 'https';
    const host = new URL(url).hostname;
    images.push({
      src: `${protocol}://${host}/assets/${bp.path === '/' ? 'home' : bp.path.split('/').filter(Boolean).join('-')}-${i + 1}.webp`,
      alt: i < missingAlt ? null : `${capitalise(bp.topic)} illustration ${i + 1}`,
      width: rng.pick([640, 960, 1200]),
      height: rng.pick([420, 540, 720]),
      loading: i === 0 ? 'eager' : 'lazy',
    });
  }
  return images;
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembly
// ─────────────────────────────────────────────────────────────────────────────

function absolute(site: DemoSiteBlueprint, path: string): string {
  // Query strings are part of the faceted-navigation demo, so they must survive.
  const [pathname, query] = path.split('?');
  const base = toAbsolute(site.domain, pathname ?? '/', 'https');
  return query ? `${base}?${query}` : base;
}

/** Build the finished crawl for one demo site. Pure — no database access. */
export function buildDemoCrawl(site: DemoSiteBlueprint, websiteId: string, now: Date): DemoCrawl {
  const rng = new Rng(`${site.key}:pages`);
  const chromePaths = [...site.nav, ...site.footer];

  // Which pages each page mentions but does not link to — the raw material for link suggestions.
  const mentionsByPath = new Map<string, string[]>();
  const linkable = site.pages.filter((p) => (p.statusCode ?? 200) === 200 && (p.targetKeywords?.length ?? 0) > 0);
  for (const bp of site.pages) {
    if ((bp.statusCode ?? 200) !== 200) continue;
    const linked = new Set([...(bp.linksTo ?? []), ...chromePaths, bp.path]);
    const candidates = linkable.filter((other) => !linked.has(other.path));
    mentionsByPath.set(
      bp.path,
      rng.sample(candidates, Math.min(2, candidates.length)).map((other) => other.targetKeywords?.[0] ?? other.topic),
    );
  }

  // Pass 1: bodies for every page that is not a copy of another page.
  const bodies = new Map<string, BuiltBody>();
  for (const bp of site.pages) {
    if (bp.duplicateOf || bp.nearDuplicateOf) continue;
    bodies.set(bp.path, buildBody(bp, site, rng, mentionsByPath.get(bp.path) ?? []));
  }
  // Pass 2: copies, now that their sources exist.
  for (const bp of site.pages) {
    const sourcePath = bp.duplicateOf ?? bp.nearDuplicateOf;
    if (!sourcePath) continue;
    const base = bodies.get(sourcePath);
    if (!base) {
      // A blueprint pointing at a page that does not exist is a bug in the blueprint, not data.
      throw new Error(`Demo blueprint ${site.key}: ${bp.path} copies unknown page ${sourcePath}`);
    }
    bodies.set(bp.path, {
      headings: base.headings,
      text: bp.duplicateOf ? base.text : makeNearDuplicate(base.text, bp, site, rng),
    });
  }

  const pages: DemoPage[] = [];
  const edges: DemoEdge[] = [];

  for (const bp of site.pages) {
    const url = absolute(site, bp.path);
    const normalized = normalizeUrl(url);
    if (!normalized) throw new Error(`Demo blueprint ${site.key}: ${bp.path} does not normalise to a URL`);

    const status = bp.statusCode ?? 200;
    const isHtml = status >= 200 && status < 300;
    const body = bodies.get(bp.path) ?? { text: '', headings: [] };
    const text = isHtml ? body.text : '';
    const wordCount = isHtml ? countWords(text) : 0;

    const robotsMeta = bp.robotsMeta ?? null;
    const isIndexable = isHtml && !(robotsMeta ?? '').includes('noindex');
    const indexabilityReason = !isHtml
      ? `HTTP ${status}`
      : isIndexable
        ? null
        : 'meta robots noindex';

    // A duplicated template also duplicates its metadata — that is what makes the duplicate-title
    // and duplicate-description findings genuine rather than decorative.
    const sourceBp = bp.duplicateOf ? site.pages.find((p) => p.path === bp.duplicateOf) : undefined;
    const metaSource = sourceBp ?? bp;
    const title =
      bp.title !== undefined
        ? bp.title
        : metaSource.title !== undefined
          ? metaSource.title
          : isHtml
            ? defaultTitle(metaSource, site)
            : null;
    const metaDescription =
      bp.metaDescription !== undefined
        ? bp.metaDescription
        : metaSource.metaDescription !== undefined
          ? metaSource.metaDescription
          : isHtml
            ? defaultMetaDescription(metaSource, site)
            : null;
    const h1 = bp.h1 ?? (isHtml ? [capitalise(bp.topic)] : []);
    const schemaTypes = bp.schemaTypes ?? (isHtml ? ['WebPage'] : []);

    const canonicalUrl =
      bp.canonicalPath === null ? null : bp.canonicalPath ? absolute(site, bp.canonicalPath) : isHtml ? url : null;

    const images = isHtml ? buildImages(bp, url, rng) : [];
    const links: DiscoveredLink[] = [];
    let position = 0;

    const pushLink = (targetPath: string, placement: 'nav' | 'footer' | 'main') => {
      const targetUrl = absolute(site, targetPath);
      const targetNormalized = normalizeUrl(targetUrl);
      if (!targetNormalized || targetPath === bp.path) return;
      const targetBp = site.pages.find((p) => p.path === targetPath);
      const anchorText =
        placement === 'main'
          ? targetBp?.targetKeywords?.[0] ?? targetBp?.topic ?? targetPath
          : targetBp
            ? capitalise(targetBp.topic).slice(0, 40)
            : targetPath;
      links.push({
        href: targetUrl,
        normalized: targetNormalized,
        anchorText,
        rel: null,
        isInternal: true,
        isNofollow: false,
        inNav: placement === 'nav',
        inFooter: placement === 'footer',
        inMainContent: placement === 'main',
        position: position++,
      });
      edges.push({
        fromPath: bp.path,
        toPath: targetPath,
        fromUrl: url,
        toUrl: targetUrl,
        anchorText,
        inNav: placement === 'nav',
        inFooter: placement === 'footer',
        inMainContent: placement === 'main',
        position: position - 1,
      });
    };

    if (isHtml) {
      if (!bp.noChrome) {
        for (const navPath of site.nav) pushLink(navPath, 'nav');
        for (const footerPath of site.footer) pushLink(footerPath, 'footer');
      }
      for (const linkPath of bp.linksTo ?? []) pushLink(linkPath, 'main');
      for (let i = 0; i < (bp.externalLinks ?? 0); i++) {
        const href = `https://www.example.org/reference/${bp.path.split('/').filter(Boolean).join('-') || 'home'}-${i + 1}`;
        links.push({
          href,
          normalized: href,
          anchorText: 'reference material',
          rel: null,
          isInternal: false,
          isNofollow: false,
          inNav: false,
          inFooter: false,
          inMainContent: true,
          position: position++,
        });
      }
    }

    const published = bp.publishedDaysAgo != null ? new Date(now.getTime() - bp.publishedDaysAgo * 86_400_000) : null;
    const updated = bp.updatedDaysAgo != null ? new Date(now.getTime() - bp.updatedDaysAgo * 86_400_000) : published;

    pages.push({
      path: bp.path,
      pageType: bp.pageType,
      targetKeywords: bp.targetKeywords ?? [bp.topic],
      publishedAt: published,
      contentUpdatedAt: updated,
      metaTitle: title,
      url,
      normalizedUrl: normalized,
      statusCode: status,
      contentType: isHtml ? 'text/html; charset=utf-8' : status >= 300 && status < 400 ? 'text/html' : null,
      redirectTarget: bp.redirectTarget ? absolute(site, bp.redirectTarget) : null,
      redirectChain: (bp.redirectChain ?? []).map((hop) => absolute(site, hop)),
      depth: urlDepth(url),
      responseTimeMs: bp.responseTimeMs ?? rng.int(140, 780),
      contentBytes: bp.contentBytes ?? (isHtml ? Math.round(text.length * 1.9) + 9_400 : 640),
      error: null,
      title,
      metaDescription,
      canonicalUrl,
      robotsMeta,
      xRobotsTag: bp.xRobotsTag ?? null,
      metaViewport: bp.noViewport ? null : 'width=device-width, initial-scale=1',
      lang: bp.noLang ? null : 'en',
      h1,
      headings: isHtml ? body.headings : [],
      wordCount,
      textContent: isHtml ? text : null,
      contentHash: isHtml && text ? contentHash(text) : null,
      simhash: isHtml && text ? simhash(text) : null,
      links,
      images,
      imagesMissingAlt: images.filter((i) => !i.alt).length,
      schemaTypes,
      structuredData: schemaTypes.map((type) => ({ '@type': type, '@context': 'https://schema.org' })),
      hreflang: [],
      isIndexable,
      indexabilityReason,
      inSitemap: bp.inSitemap ?? (site.sitemap.found && isIndexable),
      imageCount: images.length,
      externalLinkCount: links.filter((l) => !l.isInternal).length,
      internalLinkCount: links.filter((l) => l.isInternal).length,
    });
  }

  const byPath = new Map(pages.map((page) => [page.path, page]));
  const byNormalized = new Map(pages.map((page) => [page.normalizedUrl, page]));

  // Inbound/outbound counts are a link-graph property, not a crawler one, so they are filled here
  // exactly the way the worker fills them before persisting pages.
  for (const page of pages) {
    page.internalLinksOut = page.links.filter((l) => l.isInternal).length;
    page.internalLinksIn = 0;
  }
  for (const edge of edges) {
    if (edge.fromPath === edge.toPath) continue;
    const target = byPath.get(edge.toPath);
    if (target) target.internalLinksIn = (target.internalLinksIn ?? 0) + 1;
  }

  const dataset: AuditDataset = {
    websiteId,
    domain: site.domain,
    protocol: 'https',
    pages,
    edges: edges
      .filter((edge) => byNormalized.has(normalizeUrl(edge.toUrl) ?? ''))
      .map((edge) => ({
        from: normalizeUrl(edge.fromUrl) ?? edge.fromUrl,
        to: normalizeUrl(edge.toUrl) ?? edge.toUrl,
        anchorText: edge.anchorText,
        isNofollow: false,
        inMainContent: edge.inMainContent,
      })),
    robots: {
      found: site.robots.found,
      body: site.robots.found
        ? [
            'User-agent: *',
            ...site.robots.disallow.map((rule) => `Disallow: ${rule}`),
            site.sitemap.found ? `Sitemap: https://${site.domain}/sitemap.xml` : '',
          ]
            .filter(Boolean)
            .join('\n')
        : null,
      sitemaps: site.sitemap.found ? [`https://${site.domain}/sitemap.xml`] : [],
      disallowedUrls: pages
        .filter((page) => site.robots.disallow.some((rule) => page.path.startsWith(rule)))
        .map((page) => page.normalizedUrl),
    },
    sitemap: {
      found: site.sitemap.found,
      urls: site.sitemap.found ? pages.filter((page) => page.inSitemap).map((page) => page.url) : [],
      errors: site.sitemap.errors,
    },
    settings: { thinContentWords: 300, maxDepthWarn: 4 },
    skipped: [],
  };

  return { dataset, pages, byPath, edges };
}
