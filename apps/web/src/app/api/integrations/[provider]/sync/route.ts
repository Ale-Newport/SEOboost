import { z } from 'zod';
import { IntegrationProvider, IntegrationStatus, prisma } from '@seo/db';
import { ValidationError } from '@seo/shared';
import { enqueue, type EnqueueResult, type JobName } from '@seo/queue';
import { readBody, requireWebsite, route } from '@/lib/api';
import { enqueueSummary, skipped } from '@/app/api/_lib/common';
import { resolveProvider } from '@/app/api/_lib/integrations';

/**
 * `POST /api/integrations/[provider]/sync` — pull fresh data from a connected provider.
 *
 * Only the three data providers have a sync; a CMS adapter is a write target, not a source, and
 * asking it to sync is a request error rather than a silent no-op. A disconnected provider
 * returns a typed `skipped` instead of a job that would fail in the worker.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  /** Rolling window ending at the provider's freshest complete day. */
  days: z.coerce.number().int().min(1).max(480).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Search Console only: reach back over the full retention window instead of the recent one. */
  backfill: z.boolean().optional(),
  months: z.coerce.number().int().min(1).max(16).optional(),
});

const SYNC_JOBS: Partial<Record<IntegrationProvider, JobName>> = {
  [IntegrationProvider.GOOGLE_SEARCH_CONSOLE]: 'gsc.sync',
  [IntegrationProvider.GOOGLE_ANALYTICS_4]: 'ga4.sync',
  [IntegrationProvider.BING_WEBMASTER]: 'bing.sync',
};

export const POST = route<{ provider: string }>(async ({ user, request, params }) => {
  const provider = resolveProvider(params.provider);
  const body = await readBody(request, bodySchema);
  const website = await requireWebsite(user.id, body.websiteId);

  const jobName = SYNC_JOBS[provider];
  if (!jobName) {
    throw new ValidationError(
      `${provider} is a publishing target, not a data source, so it has nothing to sync. ` +
        `Syncable providers: ${Object.keys(SYNC_JOBS).join(', ')}.`,
    );
  }

  const integration = await prisma.integration.findUnique({
    where: { websiteId_provider: { websiteId: website.id, provider } },
    select: { id: true, status: true, credentials: true, config: true },
  });
  if (!integration?.credentials) {
    return skipped(
      `${provider} is not connected for this website.`,
      provider === IntegrationProvider.BING_WEBMASTER
        ? 'Set BING_API_KEY and connect Bing Webmaster Tools for this site.'
        : 'Connect the Google account at GET /api/integrations/google/authorize?websiteId=…',
    );
  }
  if (integration.status === IntegrationStatus.DISABLED) {
    return skipped(
      `The ${provider} integration is disabled for this website.`,
      'Re-enable it in Settings → Integrations before syncing.',
    );
  }

  const websiteId = website.id;
  // Each job's payload is typed separately, so the window is built once and spread per branch
  // rather than passed through a generic helper that would erase the payload types.
  const window = {
    ...(body.days ? { days: body.days } : {}),
    ...(body.from ? { from: body.from } : {}),
    ...(body.to ? { to: body.to } : {}),
  };

  let result: EnqueueResult;
  if (body.backfill && provider === IntegrationProvider.GOOGLE_SEARCH_CONSOLE) {
    result = await enqueue(
      'gsc.backfill',
      {
        websiteId,
        ...(body.months ? { months: body.months } : {}),
        ...(body.from ? { from: body.from } : {}),
        ...(body.to ? { to: body.to } : {}),
      },
      { websiteId, trigger: 'manual', dedupeKey: `gsc.backfill:${websiteId}` },
    );
  } else if (jobName === 'bing.sync') {
    result = await enqueue(
      'bing.sync',
      { websiteId, ...(body.days ? { days: body.days } : {}) },
      { websiteId, trigger: 'manual', dedupeKey: `bing.sync:${websiteId}` },
    );
  } else if (jobName === 'ga4.sync') {
    result = await enqueue('ga4.sync', { websiteId, ...window }, {
      websiteId,
      trigger: 'manual',
      dedupeKey: `ga4.sync:${websiteId}`,
    });
  } else {
    result = await enqueue('gsc.sync', { websiteId, ...window }, {
      websiteId,
      trigger: 'manual',
      dedupeKey: `gsc.sync:${websiteId}`,
    });
  }

  return { provider, websiteId, job: enqueueSummary(result) };
});
