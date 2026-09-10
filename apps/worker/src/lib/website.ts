/**
 * Loading a website and the settings that drive every processor.
 *
 * `WebsiteSettings` is optional in the schema (a site created through the API may not have one
 * yet), but no processor should have to care: `effectiveSettings()` returns the same shape
 * either way, falling back to the column defaults declared in `schema.prisma`. Nothing here
 * invents a threshold that the operator did not choose — the fallbacks are literally the
 * database defaults.
 */

import { AutonomyLevel, type Prisma, type Website, prisma } from '@seo/db';
import { NotFoundError, env } from '@seo/shared';
import type { WebsiteModelSettings } from '@seo/ai';

export type WebsiteWithSettings = Prisma.WebsiteGetPayload<{ include: { settings: true } }>;

export interface EffectiveSettings {
  crawlMaxPages: number;
  crawlMaxDepth: number;
  crawlConcurrency: number;
  crawlDelayMs: number;
  crawlUserAgent: string;
  crawlRespectRobots: boolean;
  crawlRenderJs: boolean;
  crawlIncludePatterns: string[];
  crawlExcludePatterns: string[];
  crawlTimeoutMs: number;
  autonomyLevel: AutonomyLevel;
  autoApproveSafe: boolean;
  thinContentWords: number;
  ctrOpportunityMinImpressions: number;
  strikingDistanceMin: number;
  strikingDistanceMax: number;
  monthlyAiBudgetUsd: number | null;
  models: WebsiteModelSettings;
}

/** Loads the site plus its settings row, or throws so the job fails with a clear message. */
export async function loadWebsite(websiteId: string): Promise<WebsiteWithSettings> {
  const website = await prisma.website.findUnique({
    where: { id: websiteId },
    include: { settings: true },
  });
  if (!website) throw new NotFoundError(`Website ${websiteId}`);
  return website;
}

/** The settings a processor should act on, with schema defaults filled in for a missing row. */
export function effectiveSettings(website: WebsiteWithSettings): EffectiveSettings {
  const s = website.settings;
  return {
    crawlMaxPages: s?.crawlMaxPages ?? 1000,
    crawlMaxDepth: s?.crawlMaxDepth ?? 10,
    crawlConcurrency: s?.crawlConcurrency ?? 4,
    crawlDelayMs: s?.crawlDelayMs ?? 250,
    crawlUserAgent: s?.crawlUserAgent ?? env.crawlerUserAgent,
    crawlRespectRobots: s?.crawlRespectRobots ?? true,
    crawlRenderJs: s?.crawlRenderJs ?? env.enableJsRendering,
    crawlIncludePatterns: s?.crawlIncludePatterns ?? [],
    crawlExcludePatterns: s?.crawlExcludePatterns ?? [],
    crawlTimeoutMs: s?.crawlTimeoutMs ?? 20_000,
    autonomyLevel: s?.autonomyLevel ?? AutonomyLevel.L1_DRAFTS_ONLY,
    autoApproveSafe: s?.autoApproveSafe ?? false,
    thinContentWords: s?.thinContentWords ?? 300,
    ctrOpportunityMinImpressions: s?.ctrOpportunityMinImpressions ?? 100,
    strikingDistanceMin: s?.strikingDistanceMin ?? 8,
    strikingDistanceMax: s?.strikingDistanceMax ?? 20,
    monthlyAiBudgetUsd: s?.monthlyAiBudgetUsd ?? null,
    models: {
      reasoningModel: s?.reasoningModel ?? null,
      fastModel: s?.fastModel ?? null,
      writingModel: s?.writingModel ?? null,
      embeddingModel: s?.embeddingModel ?? null,
      aiProvider: s?.aiProvider ?? null,
    },
  };
}

/** Canonical origin for the site, e.g. `https://example.com`. */
export function siteUrl(website: Pick<Website, 'domain' | 'protocol'>): string {
  return `${website.protocol || 'https'}://${website.domain}`;
}
