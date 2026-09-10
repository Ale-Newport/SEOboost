'use server';

import { z } from 'zod';
import { isUniqueViolation, prisma, setAppSetting } from '@seo/db';
import { APP_SETTING_PROVIDER_KEY, getAvailableProviders } from '@seo/ai';
import { enqueue } from '@seo/queue';
import { ForbiddenError, createLogger, errorMessage } from '@seo/shared';
import { createWebsiteSchema, domainSchema } from '@seo/shared/validation';
import { ADMIN_ROLES, assertNotReadOnly } from '@/app/api/_lib/common';
import { getCurrentUser } from '@/lib/auth';
import type { ActionResult, CrawlProgress, StartCrawlResult } from './types';

/**
 * Server actions behind the onboarding wizard.
 *
 * The wizard writes straight through to the database instead of posting to the public API:
 * every step is a small, owner-scoped mutation, and a server action keeps the ownership check
 * and the Zod schema in the same place as the write. Each action returns a typed result rather
 * than throwing, because a wizard step has to be able to show a field error without unmounting.
 */

const log = createLogger('onboarding');

/** First message per field — a control can only render one. */
function fieldErrorsFromZod(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return errors;
}

/** Optional text columns store `null`, not `''` — an empty string is not an answer. */
function orNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

const invalid = (error: string, fieldErrors?: Record<string, string>): ActionResult<never> => ({
  ok: false,
  error,
  ...(fieldErrors ? { fieldErrors } : {}),
});

const SESSION_EXPIRED = 'Your session expired. Sign in again to continue.';
const SITE_GONE = 'That website no longer exists. Go back and add it again.';

// ── Step 2: the website itself ───────────────────────────────

const websiteStepSchema = createWebsiteSchema
  .pick({
    name: true,
    domain: true,
    protocol: true,
    primaryLanguage: true,
    targetCountry: true,
    businessCategory: true,
  })
  .extend({
    /** Present when the user stepped back and edited a site this wizard already created. */
    websiteId: z.string().min(1).optional(),
  });

/**
 * Creates (or updates) the website. This is the one step that cannot be skipped — everything
 * downstream is scoped to a site — and it runs before the remaining steps precisely so a
 * refresh, an OAuth round trip or a closed tab does not throw away what was typed.
 */
export async function saveWebsiteStep(
  input: unknown,
): Promise<ActionResult<{ websiteId: string; name: string; domain: string }>> {
  const user = await getCurrentUser();
  if (!user) return invalid(SESSION_EXPIRED);

  const parsed = websiteStepSchema.safeParse(input);
  if (!parsed.success) {
    return invalid('Check the highlighted fields.', fieldErrorsFromZod(parsed.error));
  }

  const { websiteId, name, domain, protocol, primaryLanguage, targetCountry, businessCategory } =
    parsed.data;

  const shared = {
    name,
    domain,
    protocol,
    primaryLanguage,
    targetCountry,
    businessCategory: orNull(businessCategory),
  };

  try {
    if (websiteId) {
      const owned = await prisma.website.findFirst({
        where: { id: websiteId, userId: user.id },
        select: { id: true },
      });
      if (!owned) return invalid(SITE_GONE);

      const updated = await prisma.website.update({
        where: { id: websiteId },
        data: shared,
        select: { id: true, name: true, domain: true },
      });
      return { ok: true, data: { websiteId: updated.id, name: updated.name, domain: updated.domain } };
    }

    const created = await prisma.website.create({
      data: {
        userId: user.id,
        ...shared,
        // Every downstream job reads WebsiteSettings; create it with schema defaults up front
        // so no processor has to cope with a site that has none.
        settings: { create: {} },
      },
      select: { id: true, name: true, domain: true },
    });

    log.info('website created during onboarding', { websiteId: created.id, userId: user.id });
    return { ok: true, data: { websiteId: created.id, name: created.name, domain: created.domain } };
  } catch (err) {
    if (isUniqueViolation(err)) {
      return invalid('You already track this domain.', {
        domain: 'This domain is already in your portfolio.',
      });
    }
    log.error('failed to save website step', { error: errorMessage(err) });
    return invalid('Could not save the website. Check the server logs for details.');
  }
}

// ── Step 3: the business behind the website ──────────────────

const businessStepSchema = createWebsiteSchema
  .pick({ description: true, targetAudience: true, conversionGoal: true, brandName: true })
  .extend({ websiteId: z.string().min(1) });

/**
 * Writes the business context onto the site and mirrors the two fields the content agents
 * read from `KnowledgeBase`, so a description entered here is available to them without a
 * second setup pass.
 */
export async function saveBusinessStep(input: unknown): Promise<ActionResult<{ websiteId: string }>> {
  const user = await getCurrentUser();
  if (!user) return invalid(SESSION_EXPIRED);

  const parsed = businessStepSchema.safeParse(input);
  if (!parsed.success) {
    return invalid('Check the highlighted fields.', fieldErrorsFromZod(parsed.error));
  }

  const { websiteId, description, targetAudience, conversionGoal, brandName } = parsed.data;

  const owned = await prisma.website.findFirst({
    where: { id: websiteId, userId: user.id },
    select: { id: true },
  });
  if (!owned) return invalid(SITE_GONE);

  const businessDescription = orNull(description);
  const audience = orNull(targetAudience);

  try {
    await prisma.$transaction([
      prisma.website.update({
        where: { id: websiteId },
        data: {
          description: businessDescription,
          targetAudience: audience,
          conversionGoal: orNull(conversionGoal),
          brandName: orNull(brandName),
        },
      }),
      prisma.knowledgeBase.upsert({
        where: { websiteId },
        create: { websiteId, businessDescription, audience },
        update: { businessDescription, audience },
      }),
    ]);
    return { ok: true, data: { websiteId } };
  } catch (err) {
    log.error('failed to save business step', { websiteId, error: errorMessage(err) });
    return invalid('Could not save the business details. Check the server logs for details.');
  }
}

// ── Step 4: competitors ──────────────────────────────────────

const competitorsSchema = z.object({
  websiteId: z.string().min(1),
  /*
   * Matches `createWebsiteSchema.competitors`. The wizard only offers five rows, but this write
   * replaces the whole manual set — a lower cap here would reject (and, worse, delete) rows a
   * site already had when the wizard is re-opened on an established site.
   */
  domains: z.array(domainSchema).max(20),
});

/**
 * Replaces the manually-entered competitor set for the site.
 *
 * Idempotent on purpose: the wizard lets you step back and edit, so re-submitting must leave
 * exactly the domains on screen. Only `isManual` rows are touched — competitors discovered
 * later from the SERP are not the user's to lose here.
 */
export async function saveCompetitors(
  input: unknown,
): Promise<ActionResult<{ saved: number; skipped: string[] }>> {
  const user = await getCurrentUser();
  if (!user) return invalid(SESSION_EXPIRED);

  const parsed = competitorsSchema.safeParse(input);
  if (!parsed.success) {
    return invalid('Check the competitor domains.', fieldErrorsFromZod(parsed.error));
  }

  const { websiteId, domains } = parsed.data;

  const website = await prisma.website.findFirst({
    where: { id: websiteId, userId: user.id },
    select: { id: true, domain: true },
  });
  if (!website) return invalid(SITE_GONE);

  const unique = [...new Set(domains)];
  const skipped = unique.filter((domain) => domain === website.domain);
  const keep = unique.filter((domain) => domain !== website.domain);

  try {
    await prisma.$transaction([
      prisma.competitor.deleteMany({
        where: { websiteId, isManual: true, domain: { notIn: keep } },
      }),
      prisma.competitor.createMany({
        data: keep.map((domain) => ({ websiteId, domain, isManual: true })),
        skipDuplicates: true,
      }),
    ]);
    return { ok: true, data: { saved: keep.length, skipped } };
  } catch (err) {
    log.error('failed to save competitors', { websiteId, error: errorMessage(err) });
    return invalid('Could not save the competitors. Check the server logs for details.');
  }
}

// ── Step 6: default AI provider ──────────────────────────────

const providerSchema = z.object({ provider: z.string().trim().min(1).max(40) });

/**
 * Stores the installation-wide default provider in `AppSetting`, which is exactly where the
 * AI registry looks before falling back to env order. Refuses a provider with no key, because
 * saving one would produce a routing table that fails on first use.
 *
 * This writes *global* configuration, so it carries the same two guards `PATCH /api/settings`
 * does — an admin role, and the demo/read-only switch. A server action reached from a wizard is
 * not a weaker door than the settings screen.
 */
export async function saveDefaultAiProvider(input: unknown): Promise<ActionResult<{ provider: string }>> {
  const user = await getCurrentUser();
  if (!user) return invalid(SESSION_EXPIRED);

  if (!ADMIN_ROLES.some((role) => role === user.role)) {
    return invalid(
      'Only an owner or admin can set the installation-wide AI provider. You can continue — ' +
        'the default already configured stays in effect.',
    );
  }

  const parsed = providerSchema.safeParse(input);
  if (!parsed.success) return invalid('Choose one of the configured providers.');

  const available = getAvailableProviders();
  const match = available.find((entry) => entry.name === parsed.data.provider);
  if (!match) return invalid('Unknown AI provider.');
  if (!match.configured) {
    return invalid(`${match.name} has no API key on this installation. Set ${match.envVar} first.`);
  }

  try {
    await assertNotReadOnly();
    await setAppSetting(APP_SETTING_PROVIDER_KEY, match.name);
    return { ok: true, data: { provider: match.name } };
  } catch (err) {
    // `assertNotReadOnly` throws a ForbiddenError whose message is the operator-facing reason.
    if (err instanceof ForbiddenError) return invalid(err.message);
    log.error('failed to save default AI provider', { error: errorMessage(err) });
    return invalid('Could not save the provider. Check the server logs for details.');
  }
}

// ── Step 7: the first crawl ──────────────────────────────────

const websiteIdSchema = z.object({ websiteId: z.string().min(1) });

/**
 * Queues the first crawl.
 *
 * `enqueue` writes the durable `JobRecord` before touching Redis, so a broker-less
 * installation still gets a row — and this returns `enqueued: false` with the broker's own
 * explanation rather than pretending work is under way.
 */
export async function startFirstCrawl(input: unknown): Promise<ActionResult<StartCrawlResult>> {
  const user = await getCurrentUser();
  if (!user) return invalid(SESSION_EXPIRED);

  const parsed = websiteIdSchema.safeParse(input);
  if (!parsed.success) return invalid('Add the website first.');

  const website = await prisma.website.findFirst({
    where: { id: parsed.data.websiteId, userId: user.id },
    select: { id: true },
  });
  if (!website) return invalid(SITE_GONE);

  try {
    const result = await enqueue(
      'crawl.site',
      { websiteId: website.id, trigger: 'manual' },
      // One in-flight onboarding crawl per site, however many times the button is pressed.
      { dedupeKey: `onboarding:${website.id}`, trigger: 'manual' },
    );

    if (result.enqueued) {
      return {
        ok: true,
        data: {
          jobRecordId: result.kind === 'job' ? result.jobRecordId : null,
          enqueued: true,
          message: 'Crawl queued.',
        },
      };
    }

    if (result.reason === 'duplicate') {
      return {
        ok: true,
        data: {
          jobRecordId: result.jobRecordId,
          enqueued: true,
          message: 'A crawl for this site is already running.',
        },
      };
    }

    if (result.reason === 'redis-unavailable') {
      return {
        ok: true,
        data: {
          jobRecordId: result.jobRecordId,
          enqueued: false,
          message:
            'The crawl is recorded but no worker is connected: REDIS_URL is unset or Redis is ' +
            'unreachable. Start Redis and the worker process, then retry it from the Jobs screen.',
        },
      };
    }

    return invalid(result.error);
  } catch (err) {
    log.error('failed to queue first crawl', { websiteId: website.id, error: errorMessage(err) });
    return invalid('Could not queue the crawl. Check the server logs for details.');
  }
}

const crawlProgressSchema = z.object({
  websiteId: z.string().min(1),
  jobRecordId: z.string().min(1).nullable().optional(),
});

/**
 * Live crawl state for the progress step.
 *
 * Reads both the job row (queued/running/failed, with the worker's own message) and the crawl
 * row (page counts), because until a worker picks the job up there is no crawl to report on
 * and the honest answer is "queued", not "0 pages crawled".
 */
export async function getCrawlProgress(input: unknown): Promise<ActionResult<CrawlProgress>> {
  const user = await getCurrentUser();
  if (!user) return invalid(SESSION_EXPIRED);

  const parsed = crawlProgressSchema.safeParse(input);
  if (!parsed.success) return invalid('Add the website first.');

  const website = await prisma.website.findFirst({
    where: { id: parsed.data.websiteId, userId: user.id },
    select: { id: true },
  });
  if (!website) return invalid(SITE_GONE);

  const jobRecordId = parsed.data.jobRecordId ?? null;

  const [job, crawl] = await prisma.$transaction([
    prisma.jobRecord.findFirst({
      where: jobRecordId ? { id: jobRecordId, websiteId: website.id } : { websiteId: website.id, jobName: 'crawl.site' },
      orderBy: { createdAt: 'desc' },
      select: { status: true, progress: true, progressMessage: true, error: true },
    }),
    prisma.crawl.findFirst({
      where: { websiteId: website.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        pagesCrawled: true,
        pagesDiscovered: true,
        pagesFailed: true,
        issuesFound: true,
        progressMessage: true,
        startedAt: true,
        finishedAt: true,
        error: true,
      },
    }),
  ]);

  return {
    ok: true,
    data: {
      jobStatus: job?.status ?? null,
      jobProgress: job?.progress ?? 0,
      jobMessage: job?.progressMessage ?? null,
      jobError: job?.error ?? null,
      crawl: crawl
        ? {
            ...crawl,
            // Dates have to cross the server-action boundary as strings.
            startedAt: crawl.startedAt?.toISOString() ?? null,
            finishedAt: crawl.finishedAt?.toISOString() ?? null,
          }
        : null,
    },
  };
}
