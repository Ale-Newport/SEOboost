import { startCrawlSchema } from '@seo/shared';
import { readBody, requireWebsite, route } from '@/lib/api';
import { startCrawl } from '@/server/crawls';

type Params = { id: string };

/**
 * Start a crawl.
 *
 * Overrides in the body apply to this run only — the site's saved crawl settings stay put, so
 * a one-off "just 50 pages to check something" cannot quietly become the new normal.
 */
export const POST = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const input = await readBody(request, startCrawlSchema);

  const result = await startCrawl(
    website.id,
    {
      ...(input.maxPages === undefined ? {} : { maxPages: input.maxPages }),
      ...(input.maxDepth === undefined ? {} : { maxDepth: input.maxDepth }),
      ...(input.renderJs === undefined ? {} : { renderJs: input.renderJs }),
    },
    'manual',
  );

  return {
    crawl: result.crawl,
    queued: result.queued,
    // `enqueued` mirrors `queued` for the crawl card, which reads that key to warn when the
    // row was written but no broker accepted the job.
    enqueued: result.queued,
    message: result.message,
    enqueue: result.enqueue,
  };
});
