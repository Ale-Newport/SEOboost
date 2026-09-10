import { z } from 'zod';
import { prisma } from '@seo/db';
import { NotFoundError } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { assertNotReadOnly, enqueueSummary } from '@/app/api/_lib/common';
import { readBody, requireWebsite, route } from '@/lib/api';

type Params = { id: string; pageId: string };

/**
 * `POST /api/websites/[id]/pages/[pageId]/actions` — page-scoped work the detail screen offers.
 *
 * Both jobs are deliberately narrowed to this one page: `pageIds` keeps the audit and the link
 * analysis off the other 50,000 URLs, which is what makes these buttons cheap enough to sit in a
 * page header. Neither re-fetches the document — only a site crawl does that, and a one-page
 * crawl would replace the crawl every other screen reads its link graph from.
 */
const bodySchema = z.object({
  action: z.enum(['analyse', 'suggest-links']),
});

export const POST = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  await assertNotReadOnly();

  const page = await prisma.page.findFirst({
    where: { id: params.pageId, websiteId: website.id },
    select: { id: true, url: true },
  });
  if (!page) throw new NotFoundError('Page');

  const { action } = await readBody(request, bodySchema);

  if (action === 'suggest-links') {
    const result = await enqueue(
      'links.analyse-internal',
      { websiteId: website.id, pageIds: [page.id] },
      {
        websiteId: website.id,
        trigger: 'manual',
        dedupeKey: `links.analyse-internal:page:${page.id}`,
      },
    );
    return {
      action,
      pageId: page.id,
      jobs: [enqueueSummary(result)],
      message:
        'Looking for internal links that should point at this page. Suggestions appear under Internal links when it finishes.',
    };
  }

  // Re-audit against the latest crawl, then rescore. `force` matters: the scorer skips pages
  // whose content hash has not moved, and the point of pressing this button is to override that.
  const [audit, scores] = await Promise.all([
    enqueue(
      'analysis.technical-audit',
      { websiteId: website.id, pageIds: [page.id] },
      { websiteId: website.id, trigger: 'manual', dedupeKey: `analysis.technical-audit:page:${page.id}` },
    ),
    enqueue(
      'analysis.page-scores',
      { websiteId: website.id, pageIds: [page.id], force: true },
      { websiteId: website.id, trigger: 'manual', dedupeKey: `analysis.page-scores:page:${page.id}` },
    ),
  ]);

  return {
    action,
    pageId: page.id,
    jobs: [enqueueSummary(audit), enqueueSummary(scores)],
    message: 'Re-auditing and rescoring this page against the latest crawl.',
  };
});
