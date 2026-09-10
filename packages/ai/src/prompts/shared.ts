/**
 * Reusable prompt fragments.
 *
 * Anything that must be true of *every* generation lives here, once. Copying these rules into
 * individual templates is how they drift, and a drifted quality rule is how fabricated facts
 * reach a published page.
 */

/**
 * The non-negotiables, embedded in every content-producing system prompt.
 *
 * The first four rules exist because an SEO tool that invents statistics is worse than no tool
 * at all: fabricated numbers are confidently wrong, survive review, and are exactly what an
 * LLM produces when asked to sound authoritative about a topic it has no data for. The
 * remainder encode what actually ranks and what actually gets cited by AI answer engines.
 */
export const QUALITY_RULES = [
  'QUALITY RULES (non-negotiable):',
  '1. Never fabricate facts. If you do not know something, say so or omit it.',
  '2. Never invent statistics, percentages, dates, prices, study results, sources, citations,',
  '   quotes, testimonials, case studies or named experts. A plausible-sounding number you',
  '   cannot source is a defect, not a flourish.',
  '3. Any claim you cannot support from the supplied material must be flagged for human',
  '   verification (see the output contract) rather than asserted or quietly dropped.',
  '4. Prefer first-party information — the brand\'s own products, data, docs and expertise —',
  '   over generic industry commentary. First-party specifics are what makes a page worth',
  '   citing; restated common knowledge is not.',
  '5. No keyword stuffing. Use the target term naturally, plus genuine synonyms and related',
  '   entities. Repeating a phrase to hit a density target damages both rankings and readability.',
  '6. No filler. Ban throat-clearing intros ("In today\'s fast-paced digital world"), padding',
  '   ("It is important to note that"), and restating the question before answering it.',
  '7. Answer the search intent in the first two sentences. Everything after that is depth for',
  '   readers who want it, not a delay before the payoff.',
  '8. Respect the brand tone, terminology and prohibited claims given in the knowledge base.',
  '   When brand guidance conflicts with a stylistic preference of yours, the brand wins.',
  '9. Write for a specific reader with a specific problem. Concrete beats comprehensive.',
  '10. Be honest about limitations, tradeoffs and cases where the product is not the answer.',
  '    Hedged, evenly-balanced content earns citations; salesy absolutes do not.',
].join('\n');

/** Shorter variant for analysis-only prompts that never produce prose for publication. */
export const ANALYSIS_RULES = [
  'ANALYSIS RULES (non-negotiable):',
  '- Ground every judgement in the supplied data. Do not infer traffic, revenue, rankings or',
  '  competitor metrics that are not in the input.',
  '- Never invent statistics, sources, URLs or citations.',
  '- When the data is insufficient for a confident answer, say so and lower your confidence',
  '  score rather than guessing.',
  '- Prefer specific, actionable findings over generic best-practice advice the user could',
  '  have got from any blog post.',
].join('\n');

/** Reminder for prompts whose output is parsed. The schema is enforced separately. */
export const OUTPUT_CONTRACT = [
  'OUTPUT:',
  'Return only the JSON object described by the schema. No prose before or after it, no',
  'markdown fences. Use the schema\'s empty value (null, "", []) for anything genuinely',
  'unknown — never a placeholder, and never a guess dressed as a value.',
].join('\n');

/**
 * What "GEO" (generative engine optimisation) actually means, so GEO prompts optimise for
 * being *quotable by an answer engine* rather than repeating classic on-page SEO advice.
 */
export const GEO_PRINCIPLES = [
  'GENERATIVE ENGINE OPTIMISATION PRINCIPLES:',
  '- AI answer engines extract and attribute passages, not pages. A self-contained paragraph',
  '  that answers one question completely is the unit that gets cited.',
  '- Lead with a direct, 40-60 word answer, then support it. Buried answers do not get lifted.',
  '- Name entities explicitly and consistently (product, company, category, competitors).',
  '  Pronouns and vague references break entity association.',
  '- Dense, checkable facts — specifications, numbers, dates, named methods — raise citation',
  '  probability. Adjectives do not.',
  '- Structure carries meaning: descriptive H2/H3 phrased as questions, comparison tables,',
  '  ordered steps, definition sentences of the form "X is a Y that Z".',
  '- Visible expertise signals (named author with credentials, methodology, date of last',
  '  review, primary sources) affect whether an engine trusts the passage.',
  '- Schema.org markup makes the same facts machine-readable; it complements the prose, it',
  '  does not replace it.',
  '- Consistency across the site and off-site mentions strengthens the entity; contradictory',
  '  descriptions weaken it.',
].join('\n');

/** Search-intent vocabulary used by several templates, defined once so labels stay aligned. */
export const INTENT_DEFINITIONS = [
  'INTENT TAXONOMY:',
  '- INFORMATIONAL: the searcher wants to understand something. Success = a clear explanation.',
  '- COMMERCIAL: the searcher is comparing options before buying ("best", "vs", "alternatives",',
  '  "review"). Success = an honest comparison with criteria.',
  '- TRANSACTIONAL: the searcher is ready to act ("buy", "pricing", "sign up", "download").',
  '  Success = a fast path to the action.',
  '- NAVIGATIONAL: the searcher wants a specific brand, product or page. Success = that page.',
  '- LOCAL: the searcher wants something near them. Success = location, hours, directions.',
].join('\n');

/** Join non-empty lines. Keeps `render()` bodies free of conditional string concatenation. */
export function lines(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
}

/** A titled block, omitted entirely when the body is empty. */
export function section(title: string, body: string | null | undefined): string {
  const trimmed = body?.trim();
  if (!trimmed) return '';
  return `## ${title}\n${trimmed}\n`;
}

/** Bullet list, omitted entirely when there is nothing to list. */
export function bullets(items: readonly (string | null | undefined)[] | null | undefined): string {
  if (!items) return '';
  const clean = items
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .map((item) => `- ${item}`);
  return clean.join('\n');
}

/** Numbered list, for ordered material like an outline or a ranked set of options. */
export function numbered(items: readonly (string | null | undefined)[] | null | undefined): string {
  if (!items) return '';
  return items
    .map((item) => item?.trim())
    .filter((item): item is string => Boolean(item))
    .map((item, index) => `${index + 1}. ${item}`)
    .join('\n');
}

/** Pretty-printed JSON inside a fenced block, for structured input the model must read exactly. */
export function jsonBlock(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}

/** Cap long inputs so a single oversized page cannot blow the context window. */
export function clip(text: string | null | undefined, maxChars: number): string {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n…[truncated at ${maxChars} characters]`;
}

// ── Knowledge base ────────────────────────────────────────────────────────────

export interface KnowledgeBaseProduct {
  name: string;
  description?: string | null;
  url?: string | null;
}

export interface KnowledgeBaseTerm {
  term: string;
  definition: string;
}

export interface KnowledgeBaseAuthor {
  name: string;
  title?: string | null;
  bio?: string | null;
  url?: string | null;
}

/**
 * Structural mirror of the `KnowledgeBase` row. Declared here rather than imported from Prisma
 * so prompt rendering stays a pure function of plain data and can be tested without a database.
 */
export interface PromptKnowledgeBase {
  businessDescription?: string | null;
  audience?: string | null;
  toneOfVoice?: string | null;
  brandStyle?: string | null;
  preferredCta?: string | null;
  writingGuidelines?: string | null;
  prohibitedClaims?: readonly string[] | null;
  uniqueValueProps?: readonly string[] | null;
  products?: readonly KnowledgeBaseProduct[] | null;
  terminology?: readonly KnowledgeBaseTerm[] | null;
  authorBios?: readonly KnowledgeBaseAuthor[] | null;
}

/**
 * Structural mirror of a `BrandFact` row.
 *
 * `verified` must be explicitly `true` for the fact to be shown to a model — the column
 * defaults to false, and a row loaded without it (a partial `select`, a fact assembled from
 * another source) is unverified by definition. Facts with an `expiresAt` in the past should be
 * filtered out by the caller: `render()` is pure and has no clock.
 */
export interface PromptBrandFact {
  fact: string;
  category?: string | null;
  source?: string | null;
  sourceUrl?: string | null;
  verified?: boolean | null;
}

/**
 * Format the site's knowledge base and its VERIFIED brand facts into the block every
 * content prompt receives.
 *
 * Unverified facts are withheld entirely rather than shown with a caveat: a model that can see
 * an unverified claim will use it, and the caveat is the first thing lost in a long context.
 * The closing rule states plainly that these facts are the only assertable ground truth, which
 * is what makes "do not fabricate" enforceable rather than aspirational.
 *
 * Verification is opt-in (`verified === true`), matching the column default. Treating an absent
 * flag as verified would promote every unchecked claim into the one block the model is told it
 * may assert.
 */
export function renderKnowledgeBase(
  kb: PromptKnowledgeBase | null | undefined,
  facts: readonly PromptBrandFact[] | null | undefined,
): string {
  const verified = (facts ?? []).filter((fact) => fact.verified === true && fact.fact.trim());
  const parts: string[] = [];

  if (kb) {
    parts.push(section('Business', kb.businessDescription));
    parts.push(section('Audience', kb.audience));
    parts.push(section('Tone of voice', kb.toneOfVoice));
    parts.push(section('Brand style', kb.brandStyle));
    parts.push(section('Writing guidelines', kb.writingGuidelines));
    parts.push(section('Unique value propositions', bullets(kb.uniqueValueProps)));
    parts.push(
      section(
        'Products and services',
        bullets(
          kb.products?.map((product) =>
            [product.name, product.description, product.url].filter(Boolean).join(' — '),
          ),
        ),
      ),
    );
    parts.push(
      section(
        'Preferred terminology',
        bullets(kb.terminology?.map((term) => `"${term.term}": ${term.definition}`)),
      ),
    );
    parts.push(
      section(
        'Authors available to attribute',
        bullets(
          kb.authorBios?.map((author) =>
            [author.name, author.title, author.bio].filter(Boolean).join(' — '),
          ),
        ),
      ),
    );
    parts.push(section('Preferred call to action', kb.preferredCta));
    if (kb.prohibitedClaims?.length) {
      parts.push(
        section(
          'PROHIBITED CLAIMS — never write any of these, in any wording',
          bullets(kb.prohibitedClaims),
        ),
      );
    }
  }

  if (verified.length) {
    parts.push(
      section(
        'VERIFIED BRAND FACTS',
        bullets(
          verified.map((fact) => {
            const source = [fact.source, fact.sourceUrl].filter(Boolean).join(' ');
            const category = fact.category ? `[${fact.category}] ` : '';
            return `${category}${fact.fact}${source ? ` (source: ${source})` : ''}`;
          }),
        ),
      ),
    );
  }

  const body = parts.filter(Boolean).join('\n');
  if (!body) {
    return [
      '# SITE KNOWLEDGE BASE',
      'No knowledge base or verified brand facts have been provided for this site.',
      'Therefore: do not assert anything specific about this business, its products, its',
      'customers, its numbers or its history. Write only what is supportable from the other',
      'material in this prompt, and mark anything that needs brand input for human review.',
    ].join('\n');
  }

  return [
    '# SITE KNOWLEDGE BASE',
    body.trim(),
    '',
    'GROUND TRUTH RULE: the verified facts above are the only brand-specific claims you may',
    'assert. Anything else about this business — figures, dates, customer counts, awards,',
    'partnerships, guarantees — must be omitted or flagged for human verification. Unverified',
    'facts were deliberately withheld from this prompt; their absence is not permission to',
    'invent a replacement.',
  ].join('\n');
}
