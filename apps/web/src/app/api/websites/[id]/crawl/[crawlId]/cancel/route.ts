import { z } from 'zod';
import { ValidationError } from '@seo/shared';
import { requireWebsite, route } from '@/lib/api';
import { cancelCrawl } from '@/server/crawls';

type Params = { id: string; crawlId: string };

const cancelSchema = z.object({ reason: z.string().trim().max(500).optional() });

/**
 * The cancel button sends no body, so an empty request is the normal case rather than an error.
 * `readBody` would reject it, hence the explicit optional parse here.
 */
async function readReason(request: Request): Promise<string | undefined> {
  const raw = (await request.text()).trim();
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationError('Request body must be valid JSON.');
  }
  return cancelSchema.parse(parsed).reason;
}

/** Cancel a queued or running crawl. Cancelling a finished one is a no-op, not a 4xx. */
export const POST = route<Params>(async ({ user, request, params }) => {
  const website = await requireWebsite(user.id, params.id);
  const reason = await readReason(request);
  return cancelCrawl(website.id, params.crawlId, reason);
});
