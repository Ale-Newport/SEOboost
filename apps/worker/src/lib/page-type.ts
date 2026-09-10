/**
 * Page classification.
 *
 * Deterministic and URL-first on purpose: the type drives schema generation, GEO weighting and
 * content decisions, so it must be reproducible and identical between a crawl and a re-analysis.
 * An LLM guess here would make three different jobs disagree about the same URL.
 */

import { PageType } from '@seo/db';
import { getPath } from '@seo/shared';

interface Rule {
  type: PageType;
  /** Matched against the path, lower-cased, with a trailing slash guaranteed. */
  patterns: RegExp[];
}

/** Ordered: the first match wins, so specific sections beat generic ones. */
const RULES: Rule[] = [
  { type: PageType.LEGAL, patterns: [/\/(privacy|terms|legal|cookies?|imprint|gdpr|dpa|aviso-legal|politica-de-privacidad)(\/|-)/] },
  { type: PageType.CONTACT, patterns: [/\/(contact|contacto|support|help-?desk)(\/|-)/] },
  { type: PageType.ABOUT, patterns: [/\/(about|about-us|company|team|nosotros|quienes-somos|our-story)(\/|-)/] },
  { type: PageType.AUTHOR, patterns: [/\/(author|autor|writers?|contributors?)\//] },
  { type: PageType.GLOSSARY, patterns: [/\/(glossary|glosario|dictionary|terms-explained|wiki)(\/|-)/] },
  { type: PageType.FAQ, patterns: [/\/(faq|faqs|preguntas-frecuentes|questions)(\/|-)/] },
  { type: PageType.COMPARISON, patterns: [/\/(compare|comparison|vs|versus|alternatives?)(\/|-)/, /-vs-/] },
  { type: PageType.PRODUCT, patterns: [/\/(product|products|producto|productos|item|shop|store|pricing|plans)(\/|-)/] },
  { type: PageType.CATEGORY, patterns: [/\/(category|categories|categoria|collections?|tag|tags|topics?)\//] },
  { type: PageType.BLOG_INDEX, patterns: [/\/(blog|news|articles|insights|resources|recursos|noticias)\/?$/] },
  { type: PageType.ARTICLE, patterns: [/\/(blog|news|articles|insights|guides?|tutorials?|noticias|recursos)\//] },
  { type: PageType.LANDING, patterns: [/\/(lp|landing|get-started|demo|trial|signup|sign-up)(\/|-)/] },
];

/**
 * Best-effort page type from the URL, with the title used only to break the ARTICLE/LANDING
 * tie that a URL alone cannot settle.
 */
export function inferPageType(url: string, title?: string | null, homepagePath = '/'): PageType {
  const rawPath = getPath(url) || '/';
  const path = rawPath.toLowerCase();
  const withSlash = path.endsWith('/') ? path : `${path}/`;

  if (withSlash === '/' || path === homepagePath) return PageType.HOMEPAGE;

  for (const rule of RULES) {
    if (rule.patterns.some((pattern) => pattern.test(withSlash))) return rule.type;
  }

  // A deep, dated or long slug reads as editorial content; a short one at the root reads as a
  // marketing page. Both are common enough that guessing OTHER would lose real signal.
  const segments = withSlash.split('/').filter(Boolean);
  const last = segments[segments.length - 1] ?? '';
  const looksDated = /\/(19|20)\d{2}\//.test(withSlash);
  const longSlug = last.split('-').length >= 4;

  if (looksDated || (segments.length >= 2 && longSlug)) return PageType.ARTICLE;

  const heading = (title ?? '').toLowerCase();
  if (segments.length === 1 && /\b(how|why|what|guide|gu[ií]a|tutorial)\b/.test(heading)) {
    return PageType.ARTICLE;
  }
  if (segments.length === 1) return PageType.LANDING;

  return PageType.OTHER;
}
