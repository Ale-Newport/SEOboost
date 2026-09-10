/**
 * DataForSEO SERP + Keywords Data client.
 *
 * Chosen as the primary provider because it is the only one of the three that also returns
 * search volume / CPC / competition, so a single subscription covers both SERP snapshots and
 * keyword metrics. Auth is HTTP Basic with the login/password pair from the env contract.
 *
 * Endpoints used:
 *   POST /v3/serp/google/organic/live/advanced      — one blocking call, full SERP
 *   POST /v3/keywords_data/google_ads/search_volume/live — volume, competition, CPC
 */

import {
  IntegrationNotConfiguredError,
  ProviderError,
  RateLimiter,
  chunk,
  createLogger,
  env,
  isConfigured,
} from '@seo/shared';
import {
  readArray,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readRecord,
  readString,
  requestJson,
} from '../http';
import { mapResultType, toDomain, uniqueStrings } from '../parse';
import { parseLocale, toAlpha2 } from '../locale';
import type {
  FeaturedSnippetInfo,
  PeopleAlsoAskItem,
  SerpDevice,
  SerpKeywordMetric,
  SerpKeywordMetricsOptions,
  SerpProvider,
  SerpResponse,
  SerpResult,
  SerpSearchOptions,
} from '../types';

const log = createLogger('serp:dataforseo');

export const DATAFORSEO_BASE_URL = 'https://api.dataforseo.com/v3';
export const DATAFORSEO_REQUIRED_ENV = ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'] as const;

const PROVIDER = 'dataforseo';
/** Live endpoints are slow by design (they wait on Google); 90s is DataForSEO's own ceiling. */
const SEARCH_TIMEOUT_MS = 90_000;
/** DataForSEO allows 2 000 calls/min per account; 4/s leaves headroom for parallel jobs. */
const limiter = new RateLimiter(250);

/** DataForSEO country location codes are `2000 + ISO-3166-1 numeric`. */
const ISO_NUMERIC: Record<string, number> = {
  US: 840, GB: 826, CA: 124, AU: 36, NZ: 554, IE: 372, ZA: 710, DE: 276, AT: 40,
  CH: 756, FR: 250, BE: 56, NL: 528, LU: 442, ES: 724, PT: 620, IT: 380, GR: 300,
  PL: 616, CZ: 203, SK: 703, HU: 348, RO: 642, BG: 100, HR: 191, SI: 705, SE: 752,
  NO: 578, DK: 208, FI: 246, IS: 352, EE: 233, LV: 428, LT: 440, UA: 804, RU: 643,
  TR: 792, IL: 376, AE: 784, SA: 682, EG: 818, NG: 566, KE: 404, IN: 356, PK: 586,
  BD: 50, LK: 144, CN: 156, HK: 344, TW: 158, JP: 392, KR: 410, SG: 702, MY: 458,
  ID: 360, TH: 764, VN: 704, PH: 608, BR: 76, AR: 32, CL: 152, CO: 170, PE: 604,
  MX: 484, UY: 858, VE: 862, EC: 218,
};

const FALLBACK_LOCATION_CODE = 2840; // United States

export function isDataForSeoConfigured(): boolean {
  return isConfigured.dataForSeo();
}

function authHeader(): string {
  const login = env.dataForSeoLogin;
  const password = env.dataForSeoPassword;
  if (!login || !password) {
    throw new IntegrationNotConfiguredError(
      PROVIDER,
      'DataForSEO is not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD.',
    );
  }
  return `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;
}

/** Country location code for a locale, falling back to the US when the country is unmapped. */
export function locationCodeFor(locale: string | undefined): number {
  const { country } = parseLocale(locale);
  const numeric = ISO_NUMERIC[toAlpha2(country) ?? country];
  if (numeric === undefined) {
    log.warn('unmapped country for DataForSEO location_code, defaulting to US', { locale });
    return FALLBACK_LOCATION_CODE;
  }
  return 2000 + numeric;
}

/**
 * POST a DataForSEO task array and return the first task's `result` array.
 *
 * DataForSEO answers HTTP 200 even for business errors, so the envelope status codes are the
 * real error channel: 20000 is success, 5xxxx are transient server faults (retryable),
 * everything else is a request/billing problem that will not fix itself.
 */
export async function dataForSeoRequest(
  path: string,
  payload: readonly unknown[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown[]> {
  const raw = await requestJson({
    provider: PROVIDER,
    url: `${DATAFORSEO_BASE_URL}${path}`,
    method: 'POST',
    headers: { authorization: authHeader() },
    body: payload,
    timeoutMs: opts.timeoutMs ?? SEARCH_TIMEOUT_MS,
    rateLimiter: limiter,
    signal: opts.signal,
  });

  const envelope = readRecord(raw);
  if (!envelope) throw new ProviderError(PROVIDER, 'empty response envelope', true);

  const status = readNumber(envelope.status_code, 0);
  if (status !== 20000) {
    throw new ProviderError(
      PROVIDER,
      `${status} ${readString(envelope.status_message, 'unknown error')}`,
      status >= 50000,
    );
  }

  const task = readRecord(readArray(envelope.tasks)[0]);
  if (!task) throw new ProviderError(PROVIDER, 'response contained no task', true);

  const taskStatus = readNumber(task.status_code, 0);
  if (taskStatus !== 20000) {
    throw new ProviderError(
      PROVIDER,
      `task ${taskStatus} ${readString(task.status_message, 'unknown error')}`,
      taskStatus >= 50000,
    );
  }

  return readArray(task.result);
}

/** DataForSEO serves desktop and mobile SERPs only; tablet requests are served as mobile. */
function servedDevice(requested: SerpDevice | undefined): SerpDevice {
  return requested === 'mobile' || requested === 'tablet' ? 'mobile' : 'desktop';
}

function parsePeopleAlsoAsk(item: Record<string, unknown>): PeopleAlsoAskItem[] {
  const out: PeopleAlsoAskItem[] = [];
  for (const rawElement of readArray(item.items)) {
    const element = readRecord(rawElement);
    if (!element) continue;
    const question = readString(element.title) || readString(element.seed_question);
    if (!question) continue;
    const expanded = readRecord(readArray(element.expanded_element)[0]);
    out.push({
      question,
      snippet: expanded ? readOptionalString(expanded.description) : undefined,
      url: expanded ? readOptionalString(expanded.url) : undefined,
      domain: expanded ? readOptionalString(expanded.domain) : undefined,
    });
  }
  return out;
}

function parseFeaturedSnippet(item: Record<string, unknown>): FeaturedSnippetInfo | null {
  const url = readString(item.url);
  if (!url) return null;
  return {
    url,
    domain: readString(item.domain) || toDomain(url),
    title: readString(item.title),
    content: readString(item.description),
  };
}

function parseSerpResult(item: Record<string, unknown>, type: string): SerpResult | null {
  const url = readString(item.url);
  if (!url) return null;
  // `rank_group` is the position within the element's own type — the number an SEO tool
  // reports. `rank_absolute` counts every SERP block and is only a fallback.
  const position = readNumber(item.rank_group, 0) || readNumber(item.rank_absolute, 0);
  if (position <= 0) return null;
  return {
    position,
    url,
    title: readString(item.title),
    snippet: readString(item.description) || readString(item.snippet),
    domain: readString(item.domain) || toDomain(url),
    type: mapResultType(type),
  };
}

async function search(query: string, opts: SerpSearchOptions = {}): Promise<SerpResponse> {
  const { locale, language } = parseLocale(opts.locale);
  const device = servedDevice(opts.device);

  // DataForSEO accepts exactly one location dimension: a free-text `location_name` wins when
  // the caller gave one, otherwise we resolve the locale's country to a location code.
  const location = opts.location
    ? { location_name: opts.location }
    : { location_code: locationCodeFor(opts.locale) };

  const results = await dataForSeoRequest(
    '/serp/google/organic/live/advanced',
    [
      {
        keyword: query,
        ...location,
        language_code: language,
        device,
        os: device === 'mobile' ? 'android' : 'windows',
        depth: Math.min(Math.max(opts.limit ?? 20, 10), 100),
        calculate_rectangles: false,
      },
    ],
    { signal: opts.signal },
  );

  const first = readRecord(results[0]);
  const items = first ? readArray(first.items) : [];

  const organic: SerpResult[] = [];
  const peopleAlsoAsk: PeopleAlsoAskItem[] = [];
  let relatedSearches: string[] = [];
  let featuredSnippet: FeaturedSnippetInfo | null = null;
  const seenTypes: string[] = [];

  for (const rawItem of items) {
    const item = readRecord(rawItem);
    if (!item) continue;
    const type = readString(item.type);
    seenTypes.push(type);

    switch (type) {
      case 'organic':
      case 'paid':
      case 'video':
      case 'local_pack': {
        const parsed = parseSerpResult(item, type);
        if (parsed) organic.push(parsed);
        break;
      }
      case 'featured_snippet': {
        featuredSnippet = parseFeaturedSnippet(item);
        const parsed = parseSerpResult(item, type);
        if (parsed) organic.push(parsed);
        break;
      }
      case 'people_also_ask':
        peopleAlsoAsk.push(...parsePeopleAlsoAsk(item));
        break;
      case 'related_searches':
        relatedSearches = uniqueStrings(readArray(item.items).map((v) => readString(v)));
        break;
      default:
        break;
    }
  }

  const declaredTypes = first ? readArray(first.item_types).map((v) => readString(v)) : [];
  const resultTypes = uniqueStrings(
    (declaredTypes.length ? declaredTypes : seenTypes).map((t) => {
      const mapped = mapResultType(t);
      return mapped === 'other' ? t.toLowerCase() : mapped;
    }),
  );

  return {
    query,
    locale,
    device,
    provider: PROVIDER,
    results: organic.sort((a, b) => a.position - b.position),
    peopleAlsoAsk,
    relatedSearches,
    featuredSnippet,
    resultTypes,
    fetchedAt: new Date(),
  };
}

/** DataForSEO's Google Ads passthrough reports competition as a 0-100 index plus a label. */
function parseCompetition(item: Record<string, unknown>): { value: number | null; label: string | null } {
  const index = readOptionalNumber(item.competition_index);
  const rawCompetition = item.competition;

  if (typeof rawCompetition === 'string' && rawCompetition.trim() !== '') {
    return {
      value: index === undefined ? null : Math.min(1, Math.max(0, index / 100)),
      label: rawCompetition.trim().toUpperCase(),
    };
  }
  const numeric = readOptionalNumber(rawCompetition) ?? index;
  if (numeric === undefined) return { value: null, label: null };
  return { value: Math.min(1, Math.max(0, numeric > 1 ? numeric / 100 : numeric)), label: null };
}

async function keywordMetrics(
  keywords: string[],
  opts: SerpKeywordMetricsOptions = {},
): Promise<SerpKeywordMetric[]> {
  const cleaned = uniqueStrings(keywords.map((k) => k.trim().toLowerCase())).filter(
    (k) => k.length > 0 && k.length <= 80,
  );
  if (cleaned.length === 0) return [];

  const { language } = parseLocale(opts.locale);
  const locationCode = locationCodeFor(opts.locale);
  const out: SerpKeywordMetric[] = [];

  // The endpoint accepts up to 1 000 keywords per task; 700 keeps payloads comfortably small.
  for (const batch of chunk(cleaned, 700)) {
    const results = await dataForSeoRequest(
      '/keywords_data/google_ads/search_volume/live',
      [{ keywords: batch, location_code: locationCode, language_code: language, search_partners: false }],
      { signal: opts.signal },
    );

    for (const rawItem of results) {
      const item = readRecord(rawItem);
      if (!item) continue;
      const keyword = readString(item.keyword);
      if (!keyword) continue;
      const competition = parseCompetition(item);

      out.push({
        keyword,
        searchVolume: readOptionalNumber(item.search_volume) ?? null,
        competition: competition.value,
        competitionLabel: competition.label,
        cpc: readOptionalNumber(item.cpc) ?? null,
        currency: readOptionalString(item.currency) ?? null,
        monthlySearches: readArray(item.monthly_searches).flatMap((rawMonth) => {
          const month = readRecord(rawMonth);
          if (!month) return [];
          const searchVolume = readOptionalNumber(month.search_volume);
          if (searchVolume === undefined) return [];
          return [{
            year: readNumber(month.year, 0),
            month: readNumber(month.month, 0),
            searchVolume,
          }];
        }),
        source: PROVIDER,
      });
    }
  }

  return out;
}

export const dataForSeoProvider: SerpProvider = {
  name: PROVIDER,
  label: 'DataForSEO',
  requiredEnv: DATAFORSEO_REQUIRED_ENV,
  isConfigured: isDataForSeoConfigured,
  search,
  keywordMetrics,
};
