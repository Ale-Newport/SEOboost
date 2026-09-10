/**
 * Provider-neutral SERP shapes.
 *
 * Every provider (DataForSEO, SerpApi, Serper) parses into these types so the rest of the
 * platform never learns which vendor produced a snapshot. `SerpSnapshot.results` in the
 * database is exactly `SerpResult[]`.
 */

export type SerpDevice = 'desktop' | 'mobile' | 'tablet';

/**
 * Kind of SERP element a result came from. Vendors use dozens of labels; we collapse them
 * to the set the UI and scoring understand and keep the rest as `other`.
 */
export type SerpResultType =
  | 'organic'
  | 'featured_snippet'
  | 'ai_overview'
  | 'local_pack'
  | 'video'
  | 'image'
  | 'news'
  | 'shopping'
  | 'knowledge_graph'
  | 'discussion'
  | 'paid'
  | 'other';

export interface SerpResult {
  /** 1-based position within its own result type (the number an SEO tool would show). */
  position: number;
  url: string;
  title: string;
  snippet: string;
  /** Hostname of `url`, lowercased and `www.`-stripped — the domain comparison key. */
  domain: string;
  type: SerpResultType;
}

export interface PeopleAlsoAskItem {
  question: string;
  snippet?: string;
  url?: string;
  domain?: string;
}

export interface FeaturedSnippetInfo {
  url: string;
  domain: string;
  title: string;
  /** Plain-text body of the snippet, empty when the provider does not return it. */
  content: string;
}

export interface SerpResponse {
  query: string;
  /** BCP-47 locale actually requested (`en-US`). */
  locale: string;
  /** Device the results were actually served for — not necessarily the requested one. */
  device: SerpDevice;
  /** Provider slug, e.g. `dataforseo`. */
  provider: string;
  results: SerpResult[];
  peopleAlsoAsk: PeopleAlsoAskItem[];
  relatedSearches: string[];
  featuredSnippet: FeaturedSnippetInfo | null;
  /** SERP features present on the page (`featured_snippet`, `local_pack`, `video`, …). */
  resultTypes: string[];
  fetchedAt: Date;
}

export interface SerpSearchOptions {
  /** BCP-47 locale; defaults to `en-US`. */
  locale?: string;
  device?: SerpDevice;
  /** Number of organic results to request. Providers clamp to their own maximum. */
  limit?: number;
  /** Free-text location ("Austin, Texas, United States") where the provider supports it. */
  location?: string;
  signal?: AbortSignal;
}

export interface SerpKeywordMetricsOptions {
  locale?: string;
  signal?: AbortSignal;
}

/** Search-volume style metrics. Named `Serp…` to avoid clashing with the Prisma `KeywordMetric` model. */
export interface SerpKeywordMetric {
  keyword: string;
  /** Average monthly searches; null when the provider has no data for the keyword. */
  searchVolume: number | null;
  /** Paid competition normalised to 0-1. */
  competition: number | null;
  /** Provider's own label (`LOW`/`MEDIUM`/`HIGH`) when supplied. */
  competitionLabel: string | null;
  cpc: number | null;
  currency: string | null;
  monthlySearches: Array<{ year: number; month: number; searchVolume: number }>;
  /** Provider slug the metrics came from — stored in `Keyword.volumeSource`. */
  source: string;
}

export interface SerpProvider {
  /** Stable slug persisted on `SerpSnapshot.provider`. */
  readonly name: string;
  /** Human label for the settings UI. */
  readonly label: string;
  /** Env vars the operator must set to enable this provider. */
  readonly requiredEnv: readonly string[];
  isConfigured(): boolean;
  search(query: string, opts?: SerpSearchOptions): Promise<SerpResponse>;
  /** Only providers with a keyword-planner product implement this. */
  keywordMetrics?(keywords: string[], opts?: SerpKeywordMetricsOptions): Promise<SerpKeywordMetric[]>;
}
