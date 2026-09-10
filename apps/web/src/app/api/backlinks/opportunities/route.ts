import { findLinkOpportunities } from '@seo/integrations/backlinks/analysis';
import { readQuery, route } from '@/lib/api';
import { requireScopedWebsite, websiteScopeSchema } from '@/app/api/_lib/common';

/**
 * `GET /api/backlinks/opportunities?websiteId=` — places a link could legitimately be earned.
 *
 * NO OUTREACH IS PERFORMED, here or anywhere downstream. The result is a research list built
 * from our own crawl, our own link table and — where a SERP provider is configured — public
 * search results. A human decides whether to contact anyone, and does it themselves.
 *
 * It is a request-time endpoint rather than part of the page's read model because the
 * unlinked-mention check calls a SERP provider: running it on every page view would spend the
 * operator's search quota just for opening the screen.
 *
 * Checks that could not run come back in `skipped` with the reason and the env var that would
 * enable them, so a short list is never mistaken for a clean bill of health.
 */

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, websiteScopeSchema);
  const website = await requireScopedWebsite(user, query.websiteId);

  const result = await findLinkOpportunities(website.id);

  return {
    websiteId: website.id,
    generatedAt: result.generatedAt,
    opportunities: result.opportunities,
    skipped: result.skipped,
    /** Stated on the wire as well as in the UI: this list is research, not an outreach queue. */
    policy:
      'Research only. The platform performs no automated outreach, sends no email and contacts nobody.',
  };
});
