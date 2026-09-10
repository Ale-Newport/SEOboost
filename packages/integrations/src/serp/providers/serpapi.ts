/**
 * SerpApi client (https://serpapi.com).
 *
 * Read-only Google SERP fetches. SerpApi has no keyword-planner product, so this provider
 * deliberately does not implement `keywordMetrics` — the registry then falls through to a
 * provider that does (DataForSEO) or reports keyword metrics as unavailable.
 */

import {
  IntegrationNotConfiguredError,
  ProviderError,
  RateLimiter,
  env,
  isConfigured,
} from '@seo/shared';
import {
  buildQuery,
  readArray,
  readNumber,
  readOptionalString,
  readRecord,
  readString,
  requestJson,
} from '../http';
import { toDomain, uniqueStrings } from '../parse';
import { parseLocale } from '../locale';
import type {
  FeaturedSnippetInfo,
  PeopleAlsoAskItem,
  SerpDevice,
  SerpProvider,
  SerpResponse,
  SerpResult,
  SerpSearchOptions,
} from '../types';

export const SERPAPI_BASE_URL = 'https://serpapi.com/search.json';
export const SERPAPI_REQUIRED_ENV = ['SERPAPI_KEY'] as const;

const PROVIDER = 'serpapi';
const SEARCH_TIMEOUT_MS = 60_000;
/** SerpApi's default plan allows a few concurrent searches; 5/s is safely inside it. */
const limiter = new RateLimiter(200);

/** SerpApi payload key → our SERP-feature vocabulary. */
const FEATURE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['answer_box', 'featured_snippet'],
  ['knowledge_graph', 'knowledge_graph'],
  ['local_results', 'local_pack'],
  ['related_questions', 'people_also_ask'],
  ['related_searches', 'related_searches'],
  ['top_stories', 'news'],
  ['inline_videos', 'video'],
  ['inline_images', 'image'],
  ['shopping_results', 'shopping'],
  ['popular_products', 'shopping'],
  ['ads', 'paid'],
  ['ai_overview', 'ai_overview'],
  ['discussions_and_forums', 'discussion'],
  ['twitter_results', 'discussion'],
];

export function isSerpApiConfigured(): boolean {
  return isConfigured.serpApi();
}

function apiKey(): string {
  const key = env.serpApiKey;
  if (!key) {
    throw new IntegrationNotConfiguredError(PROVIDER, 'SerpApi is not configured. Set SERPAPI_KEY.');
  }
  return key;
}

/** SerpApi mirrors the requested device, so what we asked for is what was served. */
function servedDevice(requested: SerpDevice | undefined): SerpDevice {
  return requested ?? 'desktop';
}

function parseAnswerBox(raw: unknown): FeaturedSnippetInfo | null {
  const box = readRecord(raw);
  if (!box) return null;
  const url = readString(box.link);
  if (!url) return null;
  return {
    url,
    domain: toDomain(url),
    title: readString(box.title),
    content: readString(box.snippet) || readString(box.answer) || readString(box.result),
  };
}

async function search(query: string, opts: SerpSearchOptions = {}): Promise<SerpResponse> {
  const { locale, language, country } = parseLocale(opts.locale);
  const device = servedDevice(opts.device);

  const url = `${SERPAPI_BASE_URL}${buildQuery({
    engine: 'google',
    q: query,
    api_key: apiKey(),
    hl: language,
    gl: country.toLowerCase(),
    device,
    num: Math.min(Math.max(opts.limit ?? 20, 10), 100),
    location: opts.location,
    output: 'json',
  })}`;

  const raw = await requestJson({
    provider: PROVIDER,
    url,
    timeoutMs: SEARCH_TIMEOUT_MS,
    rateLimiter: limiter,
    signal: opts.signal,
  });

  const payload = readRecord(raw);
  if (!payload) throw new ProviderError(PROVIDER, 'empty response', true);

  // SerpApi reports business errors in an `error` string with HTTP 200 in some cases.
  const errorText = readOptionalString(payload.error);
  if (errorText) throw new ProviderError(PROVIDER, errorText, false);

  const results: SerpResult[] = [];
  for (const rawItem of readArray(payload.organic_results)) {
    const item = readRecord(rawItem);
    if (!item) continue;
    const link = readString(item.link);
    if (!link) continue;
    const position = readNumber(item.position, results.length + 1);
    results.push({
      position,
      url: link,
      title: readString(item.title),
      snippet: readString(item.snippet),
      domain: toDomain(link),
      type: 'organic',
    });
  }

  const peopleAlsoAsk: PeopleAlsoAskItem[] = [];
  for (const rawItem of readArray(payload.related_questions)) {
    const item = readRecord(rawItem);
    if (!item) continue;
    const question = readString(item.question);
    if (!question) continue;
    const link = readOptionalString(item.link);
    peopleAlsoAsk.push({
      question,
      snippet: readOptionalString(item.snippet),
      url: link,
      domain: link ? toDomain(link) : undefined,
    });
  }

  const relatedSearches = uniqueStrings(
    readArray(payload.related_searches).map((rawItem) => readString(readRecord(rawItem)?.query)),
  );

  const featuredSnippet = parseAnswerBox(payload.answer_box);
  const resultTypes = uniqueStrings([
    ...(results.length ? ['organic'] : []),
    ...FEATURE_KEYS.filter(([key]) => {
      const value = payload[key];
      return Array.isArray(value) ? value.length > 0 : readRecord(value) !== null;
    }).map(([, feature]) => feature),
  ]);

  return {
    query,
    locale,
    device,
    provider: PROVIDER,
    results,
    peopleAlsoAsk,
    relatedSearches,
    featuredSnippet,
    resultTypes,
    fetchedAt: new Date(),
  };
}

export const serpApiProvider: SerpProvider = {
  name: PROVIDER,
  label: 'SerpApi',
  requiredEnv: SERPAPI_REQUIRED_ENV,
  isConfigured: isSerpApiConfigured,
  search,
};
