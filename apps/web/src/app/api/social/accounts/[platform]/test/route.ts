import { z } from 'zod';
import { prisma } from '@seo/db';
import { getPublisher } from '@seo/integrations';
import { NotFoundError, ValidationError, errorMessage, truncate } from '@seo/shared';
import { tryDecryptJson } from '@seo/shared/crypto';
import { readBody, route } from '@/lib/api';
import { requireScopedWebsite } from '@/app/api/_lib/common';
import { resolvePlatform } from '@/app/api/_lib/social';

/**
 * `POST /api/social/accounts/[platform]/test` — re-run the publisher's authenticated round-trip.
 *
 * A read-only call (who am I), never a test post: the only way to find out whether posting works
 * that does not itself post something publicly.
 */

const bodySchema = z.object({ websiteId: z.string().trim().min(1) });

export const POST = route<{ platform: string }>(async ({ user, request, params }) => {
  const platform = resolvePlatform(params.platform);
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  const account = await prisma.socialAccount.findUnique({
    where: { websiteId_platform: { websiteId: website.id, platform } },
  });
  if (!account) throw new NotFoundError(`${platform} account`);
  const publisher = getPublisher(platform);
  if (!publisher) throw new ValidationError(`${platform} has no posting API.`);
  const decrypted = tryDecryptJson<Record<string, unknown>>(account.credentials);
  if (!decrypted) throw new ValidationError('No usable credentials are stored for this account. Connect it again.');

  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(decrypted)) {
    if (typeof value === 'string') credentials[key] = value;
  }
  const config =
    typeof account.config === 'object' && account.config !== null && !Array.isArray(account.config) ? { ...account.config } : {};

  let test: { ok: boolean; handle: string | null; displayName: string | null; message: string };
  try {
    test = await publisher.test({ credentials, config });
  } catch (err) {
    test = { ok: false, handle: null, displayName: null, message: errorMessage(err) };
  }

  const updated = await prisma.socialAccount.update({
    where: { id: account.id },
    data: {
      status: test.ok ? 'CONNECTED' : 'ERROR',
      lastTestedAt: new Date(),
      lastError: test.ok ? null : truncate(test.message, 1_000),
      ...(test.ok ? { handle: test.handle, displayName: test.displayName } : {}),
    },
    select: { status: true, handle: true, lastError: true, lastTestedAt: true },
  });
  return { test, account: updated };
});
