import { registerPrompt } from '../registry';
import { ANALYSIS_RULES, OUTPUT_CONTRACT, bullets, clip, lines, section } from '../shared';

export interface SchemaSuggestionVars {
  url: string;
  title?: string | null;
  content: string;
  /** @type values already emitted by the page. */
  existingSchemaTypes?: readonly string[] | null;
  /** Schema types this platform supports applying, so suggestions stay actionable. */
  supportedTypes?: readonly string[] | null;
  pageType?: string | null;
  organizationName?: string | null;
  authorName?: string | null;
  datePublished?: string | null;
  dateModified?: string | null;
}

export const schemaSuggestionPrompt = registerPrompt<SchemaSuggestionVars>({
  id: 'schema-suggestion',
  version: 1,
  description: 'Propose Schema.org JSON-LD built only from facts visible on the page.',
  defaultRole: 'fast',
  system: lines(
    'You propose Schema.org JSON-LD for a page.',
    '',
    'The governing rule: structured data must describe what is actually on the page. Marking up',
    'content that is not visible to a reader is a spam policy violation that risks a manual',
    'action, so every property you emit must be traceable to text you were given. Do not add an',
    'aggregateRating because the page has reviews-in-general, do not invent a price, do not add',
    'an author the page does not name, and do not fabricate dates.',
    '',
    'Choose types that fit, in this order of usefulness:',
    '- The page-level type (Article, BlogPosting, Product, FAQPage, HowTo, SoftwareApplication,',
    '  LocalBusiness, Event, Course, Recipe, CollectionPage, ContactPage, AboutPage).',
    '- BreadcrumbList when the URL path implies a hierarchy.',
    '- Organization or Person for the publisher, when the page identifies them.',
    '- FAQPage only when the page genuinely contains question-and-answer pairs as visible',
    '  content. This is the most commonly abused type.',
    '',
    'For each suggestion return: the @type, the complete JSON-LD object, a field-by-field note',
    'saying which page text each non-obvious property came from, whether it replaces or',
    'complements existing markup, the expected benefit, and a confidence 0-1.',
    '',
    'Separately list `missingDataForRicherMarkup`: properties that would qualify the page for a',
    'richer result if the business added them to the visible page (author credentials, published',
    'date, price, availability, ratings). This is the honest path to more markup — inventing the',
    'values is not.',
    '',
    'Emit valid JSON-LD with @context "https://schema.org". Use the real page URL for @id and',
    'url properties. Never output a placeholder such as "example.com" or "YOUR_NAME_HERE".',
    '',
    ANALYSIS_RULES,
    '',
    OUTPUT_CONTRACT,
  ),
  render: (vars) =>
    lines(
      section(
        'Page',
        lines(
          `URL: ${vars.url}`,
          vars.title ? `Title: ${vars.title}` : '',
          vars.pageType ? `Detected page type: ${vars.pageType}` : '',
          vars.organizationName ? `Publisher: ${vars.organizationName}` : '',
          vars.authorName ? `Author named on the page: ${vars.authorName}` : 'Author: none named on the page',
          vars.datePublished ? `Published: ${vars.datePublished}` : '',
          vars.dateModified ? `Modified: ${vars.dateModified}` : '',
          vars.existingSchemaTypes?.length
            ? `Existing markup: ${vars.existingSchemaTypes.join(', ')}`
            : 'Existing markup: none',
        ),
      ),
      section('Schema types this platform can apply', bullets(vars.supportedTypes)),
      section('Page content', clip(vars.content, 30000)),
      'Propose the structured data.',
    ),
});
