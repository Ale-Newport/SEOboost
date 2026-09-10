/**
 * Serper.dev client (https://serper.dev).
 *
 * The cheapest of the three providers and the fastest to answer, but its search API exposes
 * no device parameter: results are Google desktop results. We therefore report `desktop` as
 * the served device regardless of what the caller asked for, so snapshots never claim to be
 * mobile data they are not. Serper has no keyword-planner endpoint, so no `keywordMetrics`.
 */

import {
  IntegrationNotConfiguredError,
  ProviderError,
  RateLimiter,
  env,
  isConfigured,
} from '@seo/shared';
import {
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
  SerpProvider,
  SerpResponse,
  SerpResult,
  SerpSearchOptions,
} from '../types';

export const SERPER_SEARCH_URL = 'https://google.serper.dev/search';
export const SERPER_REQUIRED_ENV = ['SERPER_API_KEY'] as const;

const PROVIDER = 'serper';
const SEARCH_TIMEOUT_MS = 30_000;
/** Serper is fast and generous; 10/s keeps us well below the published burst limit. */
const limiter = new RateLimiter(100);

/** Serper payload key → our SERP-feature vocabulary. */
const FEATURE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['answerBox', 'featured_snippet'],
  ['knowledgeGraph', 'knowledge_graph'],
  ['places', 'local_pack'],
  ['topStories', 'news'],
  ['videos', 'video'],
  ['images', 'image'],
  ['shopping', 'shopping'],
  ['peopleAlsoAsk', 'people_also_ask'],
  ['relatedSearches', 'related_searches'],
];

export function isSerperConfigured(): boolean {
  return isConfigured.serper();
}

function apiKey(): string {
  const key = env.serperApiKey;
  if (!key) {
    throw new IntegrationNotConfiguredError(PROVIDER, 'Serper is not configured. Set SERPER_API_KEY.');
  }
  return key;
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
    content: readString(box.snippet) || readString(box.answer),
  };
}

async function search(query: string, opts: SerpSearchOptions = {}): Promise<SerpResponse> {
  const { locale, language, country } = parseLocale(opts.locale);

  const raw = await requestJson({
    provider: PROVIDER,
    url: SERPER_SEARCH_URL,
    method: 'POST',
    headers: { 'x-api-key': apiKey() },
    body: {
      q: query,
      gl: country.toLowerCase(),
      hl: language,
      num: Math.min(Math.max(opts.limit ?? 20, 10), 100),
      location: opts.location,
      page: 1,
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    rateLimiter: limiter,
    signal: opts.signal,
  });

  const payload = readRecord(raw);
  if (!payload) throw new ProviderError(PROVIDER, 'empty response', true);

  const errorText = readOptionalString(payload.message) ?? readOptionalString(payload.error);
  if (errorText && readArray(payload.organic).length === 0) {
    throw new ProviderError(PROVIDER, errorText, false);
  }

  const results: SerpResult[] = [];
  for (const rawItem of readArray(payload.organic)) {
    const item = readRecord(rawItem);
    if (!item) continue;
    const link = readString(item.link);
    if (!link) continue;
    results.push({
      position: readNumber(item.position, results.length + 1),
      url: link,
      title: readString(item.title),
      snippet: readString(item.snippet),
      domain: toDomain(link),
      type: 'organic',
    });
  }

  const peopleAlsoAsk: PeopleAlsoAskItem[] = [];
  for (const rawItem of readArray(payload.peopleAlsoAsk)) {
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
    readArray(payload.relatedSearches).map((rawItem) => readString(readRecord(rawItem)?.query)),
  );

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
    // Serper serves desktop results only — reporting the requested device would be a lie.
    device: 'desktop',
    provider: PROVIDER,
    results,
    peopleAlsoAsk,
    relatedSearches,
    featuredSnippet: parseAnswerBox(payload.answerBox),
    resultTypes,
    fetchedAt: new Date(),
  };
}

export const serperProvider: SerpProvider = {
  name: PROVIDER,
  label: 'Serper.dev',
  requiredEnv: SERPER_REQUIRED_ENV,
  isConfigured: isSerperConfigured,
  search,
};
