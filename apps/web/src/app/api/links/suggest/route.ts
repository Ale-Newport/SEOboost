import { z } from 'zod';
import { prisma } from '@seo/db';
import { enqueue } from '@seo/queue';
import { readBody, route } from '@/lib/api';
import { enqueueSummary, requireScopedWebsite, skipped } from '@/app/api/_lib/common';
import { findAgent } from '@/app/api/_lib/agents';

/**
 * `POST /api/links/suggest` — run the internal link analysis.
 *
 * The agent works over the whole site in one pass because a link suggestion is a *pair*: it
 * needs every candidate source page's text to find a sentence the anchor can genuinely live in.
 * It orders its work by how starved of inbound links each target is, so orphans and
 * under-linked pages are the first ones it produces suggestions for — which is what the
 * "find links for this page" button on an orphan actually buys you. The UI says so rather than
 * implying a per-page scope the agent does not have.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  /** Upper bound on the `ADD_INTERNAL_LINKS` actions the run may propose. */
  maxActions: z.coerce.number().int().min(1).max(50).optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  const pagesInScope = await prisma.page.count({ where: { websiteId: website.id, isActive: true } });
  if (pagesInScope === 0) {
    return skipped(
      'This website has no crawled pages, so there are no pages to link between.',
      'Run a crawl first; the link suggester reads the page text and link graph it records.',
    );
  }

  const agent = findAgent('internal-link');
  const result = await enqueue(
    'agents.run',
    {
      websiteId: website.id,
      agent: agent?.key ?? 'internal-link',
      trigger: 'manual',
      input: body.maxActions === undefined ? {} : { maxActions: body.maxActions },
    },
    { websiteId: website.id, trigger: 'manual', dedupeKey: `agents.run:internal-link:${website.id}` },
  );

  return { websiteId: website.id, pagesInScope, job: enqueueSummary(result) };
});
