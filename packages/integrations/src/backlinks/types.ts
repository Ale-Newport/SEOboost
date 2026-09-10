/**
 * Provider-neutral backlink shapes.
 *
 * Every source of link data — a paid API or a CSV export the user dropped in — parses into
 * `BacklinkRow`, which is deliberately a 1:1 match for the `Backlink` Prisma model minus the
 * ids. That is what lets the CSV importer and the API providers share one persistence path
 * and one analysis layer.
 */

export interface BacklinkRow {
  /** Registrable host of `sourceUrl`, lowercased and `www.`-stripped. The grouping key. */
  referringDomain: string;
  /** The page carrying the link. */
  sourceUrl: string;
  /** The page on our site being linked to. */
  targetUrl: string;
  anchorText: string | null;
  /** False for `rel="nofollow" | "ugc" | "sponsored"`. */
  isFollow: boolean;
  /**
   * Referring domain strength on a 0-100 scale. Vendors publish incompatible scales
   * (Ahrefs DR 0-100, Moz DA 0-100, DataForSEO rank 0-1000); each client normalises to
   * 0-100 so the analysis layer can compare them. Null when the source has no metric.
   */
  domainAuthority: number | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  /** Set when the source reports the link as gone. Null while it is live. */
  lostAt: Date | null;
  /** Slug of whatever produced the row (`csv`, `dataforseo`, `ahrefs`, …). */
  provider: string;
}

export interface ReferringDomainRow {
  domain: string;
  /** Links from this domain to us. */
  backlinks: number;
  /** Distinct pages of ours it links to; null when the provider does not report it. */
  linkedPages: number | null;
  domainAuthority: number | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  /** True when at least one link from the domain is followed. */
  isFollow: boolean;
}

export interface BacklinkFetchOptions {
  /** Maximum rows to return. Providers clamp to their own page ceiling. */
  limit?: number;
  /** Skip links first seen before this date, where the provider supports the filter. */
  since?: Date;
  /** Include links the provider has marked as lost. Default false. */
  includeLost?: boolean;
  /** Restrict to links pointing at this exact URL rather than the whole domain. */
  targetUrl?: string;
  signal?: AbortSignal;
}

/**
 * A backlink source.
 *
 * `fetchBacklinks` is the only required capability; the optional methods exist because the
 * vendors differ (Moz has no cheap competitor endpoint, Semrush's referring-domain report is
 * a separate product). The registry never assumes an optional method is present.
 */
export interface BacklinkProvider {
  /** Stable slug persisted on `Backlink.provider`. */
  readonly name: string;
  /** Human label for the settings UI. */
  readonly label: string;
  /** Env vars the operator must set to enable this provider. */
  readonly requiredEnv: readonly string[];
  /** Env-only check. Must never touch the network or the database. */
  isConfigured(): boolean;
  /** Links pointing at `domain`. Throws `IntegrationNotConfiguredError` when unconfigured. */
  fetchBacklinks(domain: string, opts?: BacklinkFetchOptions): Promise<BacklinkRow[]>;
  /** Aggregated per-referring-domain view, when the vendor exposes one. */
  fetchReferringDomains?(domain: string, opts?: BacklinkFetchOptions): Promise<ReferringDomainRow[]>;
  /**
   * Links pointing at competitor domains, for gap analysis. Rows keep the competitor URL in
   * `targetUrl`, so they are never written to our own `Backlink` table.
   */
  fetchCompetitorBacklinks?(
    domains: readonly string[],
    opts?: BacklinkFetchOptions,
  ): Promise<BacklinkRow[]>;
}

export interface BacklinkProviderInfo {
  name: string;
  label: string;
  configured: boolean;
  requiredEnv: string[];
  supportsReferringDomains: boolean;
  supportsCompetitorGap: boolean;
}
