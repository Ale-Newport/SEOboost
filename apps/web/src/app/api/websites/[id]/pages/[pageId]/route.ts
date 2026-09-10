import { NotFoundError } from '@seo/shared';
import { requireWebsite, route } from '@/lib/api';
import { getPageProfile } from '@/server/queries/pages';

type Params = { id: string; pageId: string };

/**
 * The full page profile: metrics, keywords, issues, links, snapshots and recommendations.
 *
 * Link data comes from the latest completed crawl rather than from live counters, so the
 * inbound/outbound lists always agree with each other and with the crawl they were measured in.
 * `crawlId: null` means the site has never finished a crawl — the screen asks for one instead
 * of rendering an empty link graph as if the page had no links.
 */
export const GET = route<Params>(async ({ user, params }) => {
  await requireWebsite(user.id, params.id);

  const profile = await getPageProfile(params.id, params.pageId);
  if (!profile) throw new NotFoundError('Page');

  return profile;
});
