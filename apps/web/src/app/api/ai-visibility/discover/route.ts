import { z } from 'zod';
import { enqueue } from '@seo/queue';
import { isAiAvailable } from '@seo/ai';
import { readBody, route } from '@/lib/api';
import { enqueueSummary, requireScopedWebsite, skipped } from '@/app/api/_lib/common';

/**
 * `POST /api/ai-visibility/discover` — propose prompts worth tracking for this site.
 *
 * Discovery reads the site's own keywords and knowledge base to build the prompt set, so it
 * needs a model. Without one the endpoint says so instead of queueing work that cannot run.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  locale: z.string().trim().min(2).max(10).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  if (!isAiAvailable()) {
    return skipped(
      'No AI provider is configured, so prompts cannot be discovered.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY, or add prompts by hand with ' +
        'POST /api/ai-visibility/prompts.',
    );
  }

  const result = await enqueue(
    'aivis.discover-prompts',
    {
      websiteId: website.id,
      ...(body.locale ? { locale: body.locale } : {}),
      ...(body.limit ? { limit: body.limit } : {}),
    },
    { websiteId: website.id, trigger: 'manual', dedupeKey: `aivis.discover-prompts:${website.id}` },
  );

  return { websiteId: website.id, job: enqueueSummary(result) };
});
