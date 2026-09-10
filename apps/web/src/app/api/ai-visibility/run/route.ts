import { z } from 'zod';
import { prisma } from '@seo/db';
import { enqueue } from '@seo/queue';
import { getAvailableProviders, isAiAvailable } from '@seo/ai';
import { readBody, route } from '@/lib/api';
import { enqueueSummary, requireScopedWebsite, skipped } from '@/app/api/_lib/common';

/**
 * `POST /api/ai-visibility/run` — query the tracked prompts against the configured providers.
 *
 * Refuses up front when the install has no AI key or the site has no active prompts: both
 * produce a job that can only fail, and the operator needs the reason now, not in the job log.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  promptIds: z.array(z.string().trim().min(1)).max(500).optional(),
  /** Provider keys to run; omit for every configured provider. */
  providers: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  locale: z.string().trim().min(2).max(10).optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  if (!isAiAvailable()) {
    return skipped(
      'No AI provider is configured on this installation, so no prompt can be queried.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY — or use ' +
        'POST /api/ai-visibility/import to record answers you collected manually.',
    );
  }

  if (body.providers?.length) {
    const configured = new Set<string>(
      getAvailableProviders().filter((provider) => provider.configured).map((provider) => provider.name),
    );
    const missing = body.providers.filter((name) => !configured.has(name));
    if (missing.length > 0) {
      return skipped(
        `These providers are not configured: ${missing.join(', ')}.`,
        'Set the matching API key, or drop them from the request to run only what is configured.',
      );
    }
  }

  const activePrompts = await prisma.aiVisibilityPrompt.count({
    where: {
      websiteId: website.id,
      isActive: true,
      ...(body.promptIds?.length ? { id: { in: body.promptIds } } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
    },
  });
  if (activePrompts === 0) {
    return skipped(
      'This website has no active prompts to run.',
      'Add prompts with POST /api/ai-visibility/prompts, or queue POST /api/ai-visibility/discover.',
    );
  }

  const result = await enqueue(
    'aivis.run-prompts',
    {
      websiteId: website.id,
      ...(body.promptIds?.length ? { promptIds: body.promptIds } : {}),
      ...(body.providers?.length ? { providers: body.providers } : {}),
      ...(body.locale ? { locale: body.locale } : {}),
    },
    { websiteId: website.id, trigger: 'manual', dedupeKey: `aivis.run-prompts:${website.id}` },
  );

  return { websiteId: website.id, promptsInScope: activePrompts, job: enqueueSummary(result) };
});
