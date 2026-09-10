import { z } from 'zod';
import { isUniqueViolation, prisma } from '@seo/db';
import { ConflictError, createLogger, createWebsiteSchema, errorMessage } from '@seo/shared';
import { type ScheduleSummary, ensureDefaultSchedules, syncSchedules } from '@seo/queue';
import { readBody, readQuery, route } from '@/lib/api';
import { type StartCrawlResult, startCrawl } from '@/server/crawls';
import { listWebsiteSummaries } from '@/server/queries/websites';
import { booleanParam } from '@/server/queries/filters';

const log = createLogger('api:websites');

const listQuerySchema = z.object({
  includeArchived: booleanParam.optional(),
});

/** The site list, with the rolled-up metrics the cards render. */
export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, listQuerySchema);
  const websites = await listWebsiteSummaries(user.id, {
    includeArchived: query.includeArchived ?? false,
  });
  return { websites, total: websites.length };
});

/** Empty strings arrive from optional form inputs; the database wants null, not `''`. */
function nullable(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Create a website.
 *
 * One nested `create` builds the Website, its settings and its knowledge base together, so a
 * failure part-way cannot leave a site without the settings row that `ensureDefaultSchedules`
 * and every crawl read from. The two follow-up steps — schedules and the first crawl — are
 * deliberately outside that atomic write: neither should be able to undo an otherwise valid
 * site, so each reports its own outcome instead of throwing.
 */
export const POST = route(async ({ user, request }) => {
  const input = await readBody(request, createWebsiteSchema);

  // A site listing itself as a competitor would poison every gap analysis.
  const competitorDomains = [...new Set(input.competitors)].filter(
    (domain) => domain !== input.domain,
  );

  let website;
  try {
    website = await prisma.website.create({
      data: {
        userId: user.id,
        name: input.name,
        domain: input.domain,
        protocol: input.protocol,
        description: nullable(input.description),
        businessCategory: nullable(input.businessCategory),
        targetAudience: nullable(input.targetAudience),
        conversionGoal: nullable(input.conversionGoal),
        brandName: nullable(input.brandName),
        primaryLanguage: input.primaryLanguage,
        targetLocales: input.targetLocales,
        targetCountry: input.targetCountry,
        cmsType: input.cmsType,
        settings: { create: {} },
        knowledgeBase: { create: {} },
        competitors: {
          create: competitorDomains.map((domain) => ({ domain, isManual: true })),
        },
      },
      include: { settings: true, knowledgeBase: true, competitors: true },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(`You already track ${input.domain}.`, { domain: input.domain });
    }
    throw err;
  }

  // Reads the cron columns the settings row was just created with, so the five managed
  // schedules exist from minute one. `syncSchedules()` then projects them onto BullMQ —
  // without it the rows would sit in Postgres and nothing would actually fire until some
  // other caller happened to reconcile. Both steps are best-effort: the site is already
  // committed, and a broker hiccup must not report a valid site as a failed creation.
  let schedules: ScheduleSummary[] = [];
  let scheduleError: string | null = null;
  try {
    schedules = await ensureDefaultSchedules(website.id);
    await syncSchedules();
  } catch (err) {
    scheduleError = errorMessage(err);
    log.warn('website created but schedules could not be registered', {
      websiteId: website.id,
      error: scheduleError,
    });
  }

  let crawl: StartCrawlResult | null = null;
  let crawlError: string | null = null;
  if (input.startCrawl) {
    try {
      crawl = await startCrawl(website.id, {}, 'api');
    } catch (err) {
      crawlError = errorMessage(err);
      log.warn('website created but the first crawl could not be started', {
        websiteId: website.id,
        error: crawlError,
      });
    }
  }

  log.info('website created', {
    websiteId: website.id,
    competitors: competitorDomains.length,
    schedules: schedules.length,
    crawlQueued: crawl?.queued ?? false,
  });

  return {
    // Flat aliases the create-site form redirects on; the nested objects carry the detail.
    id: website.id,
    crawlEnqueued: crawl === null ? null : crawl.queued,
    website,
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      label: schedule.label,
      cron: schedule.cron,
      isEnabled: schedule.isEnabled,
      nextRunAt: schedule.nextRunAt,
    })),
    scheduleError,
    crawl: crawl
      ? { crawlId: crawl.crawl.id, queued: crawl.queued, message: crawl.message }
      : null,
    crawlError,
  };
});
