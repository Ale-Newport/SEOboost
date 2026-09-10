import { z } from 'zod';
import { IntegrationProvider, prisma } from '@seo/db';
import { createLogger, isSameSite } from '@seo/shared';
import {
  ensureBingIntegration,
  isBingConfigured,
  readBingConfig,
  submitBingSitemap,
  submitBingUrls,
} from '@seo/integrations/bing/webmaster';
import { readBody, route } from '@/lib/api';
import { assertNotReadOnly, requireScopedWebsite, skipped } from '@/app/api/_lib/common';

const log = createLogger('api:indexation:submit');

/**
 * `POST /api/indexation/submit` — hand URLs or a sitemap to a search engine that accepts them.
 *
 * Bing only, and that is not an oversight. Google publishes no general-purpose indexing API:
 * the Indexing API is limited to `JobPosting` and `BroadcastEvent` structured data, so no
 * platform can push an ordinary page into Google's index. Pretending otherwise would be the
 * kind of claim this codebase refuses to make, so the Google path is simply absent and the UI
 * says why.
 *
 * Every failure is returned as typed data rather than thrown: a missing key or a tenant whose
 * account does not expose the submission API is an answer, not a server error.
 */

const bodySchema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('urls'),
    websiteId: z.string().trim().min(1),
    urls: z.array(z.string().trim().url()).min(1).max(500),
  }),
  z.object({
    target: z.literal('sitemap'),
    websiteId: z.string().trim().min(1),
    feedUrl: z.string().trim().url(),
  }),
]);

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  await assertNotReadOnly();
  const website = await requireScopedWebsite(user, body.websiteId);

  if (!isBingConfigured()) {
    return skipped(
      'Bing Webmaster Tools is not configured, so nothing can be submitted.',
      'Set BING_API_KEY. Google has no equivalent endpoint for ordinary pages — its Indexing API ' +
        'only accepts JobPosting and BroadcastEvent — so no submission path exists there at all.',
    );
  }

  // Refuse to hand a search engine a URL that is not ours. The property is verified on Bing's
  // side, but a mistyped payload should fail here rather than there.
  const offSite =
    body.target === 'urls'
      ? body.urls.filter((url) => !isSameSite(url, website.domain))
      : isSameSite(body.feedUrl, website.domain)
        ? []
        : [body.feedUrl];
  if (offSite.length > 0) {
    return skipped(
      `These URLs do not belong to ${website.domain}: ${offSite.slice(0, 5).join(', ')}.`,
      'Submit only URLs on this website. Add the other domain as its own site to submit for it.',
    );
  }

  const integration = await prisma.integration.findFirst({
    where: { websiteId: website.id, provider: IntegrationProvider.BING_WEBMASTER },
    select: { config: true },
  });
  let siteUrl = readBingConfig(integration?.config ?? null).siteUrl ?? null;

  if (!siteUrl) {
    // First use on this site: resolve the verified property from the Bing account by domain.
    const ensured = await ensureBingIntegration(website.id);
    siteUrl = ensured.siteUrl;
    if (!siteUrl) {
      return skipped(
        ensured.reason ?? `No verified Bing property matches ${website.domain}.`,
        'Verify the site in Bing Webmaster Tools with the same account the API key belongs to, then retry.',
      );
    }
  }

  if (body.target === 'sitemap') {
    const result = await submitBingSitemap(siteUrl, body.feedUrl);
    if (!result.ok) {
      return { ok: false, target: 'sitemap' as const, siteUrl, error: result.error, code: result.code };
    }
    log.info('sitemap submitted to bing', { websiteId: website.id, feedUrl: body.feedUrl });
    return { ok: true, target: 'sitemap' as const, siteUrl, feedUrl: body.feedUrl, submittedAt: result.data.submittedAt };
  }

  const result = await submitBingUrls(siteUrl, body.urls);
  if (!result.ok) {
    return { ok: false, target: 'urls' as const, siteUrl, error: result.error, code: result.code };
  }
  log.info('urls submitted to bing', { websiteId: website.id, submitted: result.data.submitted });
  return {
    ok: true,
    target: 'urls' as const,
    siteUrl,
    submitted: result.data.submitted,
    batches: result.data.batches,
  };
});
