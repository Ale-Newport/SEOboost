'use server';

import { z } from 'zod';
import { type Prisma, json, prisma } from '@seo/db';
import { createLogger, errorMessage, knowledgeBaseSchema } from '@seo/shared';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { getCurrentUser } from '@/lib/auth';
import type { SettingsActionResult } from '@/components/site-settings/action-types';

/**
 * The two settings mutations that have no HTTP route to call.
 *
 * Everything else on this screen posts to an existing endpoint (`PATCH /api/websites/[id]`,
 * `PATCH …/settings`, `POST|DELETE …/brand-facts`, `/api/integrations/*`). These two do not:
 * editing an existing brand fact has no route at all, and the knowledge base is a `PUT`, which
 * the browser API client does not speak. A server action keeps the ownership check and the shared
 * Zod schema in the same place as the write, exactly as the onboarding wizard does.
 */

const log = createLogger('site-settings');

const failed = (error: string): SettingsActionResult<never> => ({ ok: false, error });

/** Resolves the caller and proves they own this site. Returns a message rather than throwing. */
async function requireOwnedWebsite(websiteId: string): Promise<
  { ok: true; websiteId: string } | { ok: false; error: string }
> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: 'Your session expired. Sign in again to continue.' };

  const website = await prisma.website.findFirst({
    where: { id: websiteId, userId: user.id },
    select: { id: true },
  });
  if (!website) return { ok: false, error: 'That website no longer exists, or you cannot access it.' };
  return { ok: true, websiteId: website.id };
}

// ── Brand facts ──────────────────────────────────────────────

const updateFactSchema = z.object({
  websiteId: z.string().trim().min(1),
  factId: z.string().trim().min(1),
  fact: z.string().trim().min(3).max(1000).optional(),
  category: z.string().trim().max(80).nullable().optional(),
  source: z.string().trim().min(1).max(120).optional(),
  sourceUrl: z.string().trim().max(2048).nullable().optional(),
  verified: z.boolean().optional(),
  /** ISO date after which the fact must no longer be quoted; null clears it. */
  expiresAt: z.string().datetime().nullable().optional(),
});

export interface UpdatedBrandFact {
  id: string;
  verified: boolean;
  verifiedAt: string | null;
}

/**
 * Edit one brand fact — including flipping `verified`, which is the switch that decides whether
 * an AI writer may assert it in published copy.
 *
 * `verifiedAt` is stamped only on the transition to verified, so the audit trail records when a
 * human actually vouched for the claim rather than when the row was last touched.
 */
export async function updateBrandFact(input: unknown): Promise<SettingsActionResult<UpdatedBrandFact>> {
  const parsed = updateFactSchema.safeParse(input);
  if (!parsed.success) return failed(parsed.error.issues[0]?.message ?? 'That change is not valid.');

  const owned = await requireOwnedWebsite(parsed.data.websiteId);
  if (!owned.ok) return failed(owned.error);

  try {
    await assertNotReadOnly();
  } catch (cause) {
    return failed(errorMessage(cause));
  }

  const existing = await prisma.brandFact.findFirst({
    where: { id: parsed.data.factId, websiteId: owned.websiteId },
    select: { id: true, verified: true },
  });
  if (!existing) return failed('That fact has already been deleted.');

  const data: Prisma.BrandFactUncheckedUpdateInput = {};
  if (parsed.data.fact !== undefined) data.fact = parsed.data.fact;
  if (parsed.data.category !== undefined) data.category = parsed.data.category?.trim() || null;
  if (parsed.data.source !== undefined) data.source = parsed.data.source;
  if (parsed.data.sourceUrl !== undefined) data.sourceUrl = parsed.data.sourceUrl?.trim() || null;
  if (parsed.data.expiresAt !== undefined) {
    data.expiresAt = parsed.data.expiresAt === null ? null : new Date(parsed.data.expiresAt);
  }
  if (parsed.data.verified !== undefined) {
    data.verified = parsed.data.verified;
    if (parsed.data.verified !== existing.verified) {
      data.verifiedAt = parsed.data.verified ? new Date() : null;
    }
  }

  try {
    const fact = await prisma.brandFact.update({
      where: { id: existing.id },
      data,
      select: { id: true, verified: true, verifiedAt: true },
    });

    log.info('brand fact updated', {
      websiteId: owned.websiteId,
      factId: fact.id,
      verified: fact.verified,
    });

    return {
      ok: true,
      data: {
        id: fact.id,
        verified: fact.verified,
        verifiedAt: fact.verifiedAt?.toISOString() ?? null,
      },
    };
  } catch (cause) {
    log.warn('brand fact update failed', {
      websiteId: owned.websiteId,
      error: errorMessage(cause),
    });
    return failed(errorMessage(cause));
  }
}

// ── Knowledge base ───────────────────────────────────────────

const saveKnowledgeSchema = knowledgeBaseSchema.extend({
  websiteId: z.string().trim().min(1),
});

/**
 * Replace the site's knowledge base.
 *
 * A whole-document write, like the `PUT` route it mirrors: the form edits every section at once,
 * and "remove this product" has to mean the row disappears rather than merging back in.
 */
export async function saveKnowledgeBase(input: unknown): Promise<SettingsActionResult<{ savedAt: string }>> {
  const parsed = saveKnowledgeSchema.safeParse(input);
  if (!parsed.success) return failed(parsed.error.issues[0]?.message ?? 'That change is not valid.');

  const owned = await requireOwnedWebsite(parsed.data.websiteId);
  if (!owned.ok) return failed(owned.error);

  try {
    await assertNotReadOnly();
  } catch (cause) {
    return failed(errorMessage(cause));
  }

  const payload = {
    businessDescription: parsed.data.businessDescription ?? null,
    audience: parsed.data.audience ?? null,
    toneOfVoice: parsed.data.toneOfVoice ?? null,
    brandStyle: parsed.data.brandStyle ?? null,
    preferredCta: parsed.data.preferredCta ?? null,
    writingGuidelines: parsed.data.writingGuidelines ?? null,
    prohibitedClaims: parsed.data.prohibitedClaims ?? [],
    uniqueValueProps: parsed.data.uniqueValueProps ?? [],
    products: json(parsed.data.products ?? []),
    terminology: json(parsed.data.terminology ?? []),
    authorBios: json(parsed.data.authorBios ?? []),
  } satisfies Prisma.KnowledgeBaseUncheckedUpdateInput;

  try {
    const saved = await prisma.knowledgeBase.upsert({
      where: { websiteId: owned.websiteId },
      create: { websiteId: owned.websiteId, ...payload },
      update: payload,
      select: { updatedAt: true },
    });

    log.info('knowledge base saved', { websiteId: owned.websiteId });
    return { ok: true, data: { savedAt: saved.updatedAt.toISOString() } };
  } catch (cause) {
    log.warn('knowledge base save failed', {
      websiteId: owned.websiteId,
      error: errorMessage(cause),
    });
    return failed(errorMessage(cause));
  }
}
