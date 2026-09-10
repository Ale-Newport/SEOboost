import { z } from 'zod';
import { prisma } from '@seo/db';
import {
  NotFoundError,
  containsPhrase,
  createLogger,
  isSameSite,
  round,
} from '@seo/shared';
import { readBody, route } from '@/lib/api';
import { requireScopedWebsite } from '@/app/api/_lib/common';

const log = createLogger('api:ai-visibility');

/**
 * `POST /api/ai-visibility/import` — record an answer collected by hand.
 *
 * This is the compliant path for the assistants we cannot query through an API. The operator
 * runs the prompt in the product's own interface and pastes the answer back; we never scrape a
 * consumer UI or drive it with a headless browser.
 *
 * Everything derived here is derived *from the pasted text*: whether the brand appears, which
 * of the cited URLs are ours, and which tracked competitors are named. Nothing is estimated —
 * a field the operator did not supply and the text does not support stays null. Rows are
 * stored with `method: 'manual'` so a manual observation is never mistaken for an API sample.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  promptId: z.string().trim().min(1),
  /** The assistant the answer came from, e.g. 'chatgpt', 'perplexity', 'gemini'. */
  provider: z.string().trim().min(1).max(60),
  model: z.string().trim().max(120).optional(),
  answerText: z.string().trim().min(1).max(200_000),
  /** Every URL the answer cited, in the order it cited them. */
  citedUrls: z.array(z.string().trim().max(2048)).max(200).default([]),
  /** Override the derived value when the operator can see something the text match cannot. */
  brandMentioned: z.boolean().optional(),
  brandSentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
  competitorsMentioned: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  /** When the answer was actually collected; defaults to now. */
  runAt: z.coerce.date().optional(),
});

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  const prompt = await prisma.aiVisibilityPrompt.findFirst({
    where: { id: body.promptId, websiteId: website.id },
    select: { id: true, expectedBrand: true },
  });
  if (!prompt) throw new NotFoundError('AI visibility prompt');

  const brandName = prompt.expectedBrand?.trim() || website.brandName?.trim() || website.name;
  const answer = body.answerText;

  const brandMentioned = body.brandMentioned ?? containsPhrase(answer, brandName);

  // "Ours" is decided by hostname, not by string matching, so a competitor blog post *about*
  // the brand is never counted as our citation.
  const ourUrlsCited = body.citedUrls.filter((url) => isSameSite(url, website.domain));

  const competitors = await prisma.competitor.findMany({
    where: { websiteId: website.id, isActive: true },
    select: { domain: true, name: true },
  });

  const derivedCompetitors =
    body.competitorsMentioned ??
    competitors
      .filter((competitor) => {
        const label = competitor.name?.trim() || competitor.domain;
        return containsPhrase(answer, label) || answer.toLowerCase().includes(competitor.domain.toLowerCase());
      })
      .map((competitor) => competitor.name?.trim() || competitor.domain);

  // Ordinal position: how many other named brands appear before ours in the answer.
  const lowerAnswer = answer.toLowerCase();
  const brandIndex = lowerAnswer.indexOf(brandName.toLowerCase());
  const brandPosition =
    brandMentioned && brandIndex >= 0
      ? 1 +
        derivedCompetitors.filter((name) => {
          const index = lowerAnswer.indexOf(name.toLowerCase());
          return index >= 0 && index < brandIndex;
        }).length
      : null;

  const run = await prisma.aiVisibilityRun.create({
    data: {
      websiteId: website.id,
      promptId: prompt.id,
      provider: body.provider.toLowerCase(),
      model: body.model ?? null,
      method: 'manual',
      answerText: answer,
      brandMentioned,
      brandPosition,
      brandSentiment: body.brandSentiment ?? null,
      citedUrls: body.citedUrls,
      ourUrlsCited,
      competitorsMentioned: derivedCompetitors,
      // A pasted transcript is an exact record of what was said, so parsing confidence is 1.
      confidence: 1,
      runAt: body.runAt ?? new Date(),
      mentions: {
        create: [
          ...(brandMentioned
            ? [
                {
                  entityName: brandName,
                  isOurBrand: true,
                  position: brandPosition,
                  ...(ourUrlsCited[0] ? { citedUrl: ourUrlsCited[0] } : {}),
                  ...(body.brandSentiment ? { sentiment: body.brandSentiment } : {}),
                },
              ]
            : []),
          ...derivedCompetitors.map((name) => ({ entityName: name, isOurBrand: false })),
        ],
      },
    },
    select: { id: true, runAt: true, brandMentioned: true, brandPosition: true, ourUrlsCited: true },
  });

  // Recompute the prompt's rolling rates from every stored run, so the number on the prompt is
  // always the aggregate of what we actually observed rather than an incrementally drifting one.
  const [total, mentioned, cited] = await Promise.all([
    prisma.aiVisibilityRun.count({ where: { promptId: prompt.id, error: null } }),
    prisma.aiVisibilityRun.count({ where: { promptId: prompt.id, error: null, brandMentioned: true } }),
    prisma.aiVisibilityRun.count({
      where: { promptId: prompt.id, error: null, NOT: { ourUrlsCited: { isEmpty: true } } },
    }),
  ]);

  await prisma.aiVisibilityPrompt.update({
    where: { id: prompt.id },
    data: {
      lastRunAt: run.runAt,
      mentionRate: total === 0 ? null : round(mentioned / total, 4),
      citationRate: total === 0 ? null : round(cited / total, 4),
    },
  });

  log.info('manual ai visibility result imported', {
    websiteId: website.id,
    promptId: prompt.id,
    provider: body.provider,
    brandMentioned,
  });

  return {
    run,
    derived: {
      brandName,
      brandMentioned,
      brandPosition,
      ourUrlsCited,
      competitorsMentioned: derivedCompetitors,
    },
    promptRates: {
      runs: total,
      mentionRate: total === 0 ? null : round((mentioned / total) * 100, 1),
      citationRate: total === 0 ? null : round((cited / total) * 100, 1),
    },
  };
});
