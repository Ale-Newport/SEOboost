import { z } from 'zod';
import { type Prisma, json, prisma } from '@seo/db';
import { getPublisher, publisherInfo } from '@seo/integrations';
import { ValidationError, createLogger, errorMessage, truncate } from '@seo/shared';
import { encryptJson, tryDecryptJson } from '@seo/shared/crypto';
import { readBody, readQuery, route } from '@/lib/api';
import { assertNotReadOnly, requireScopedWebsite } from '@/app/api/_lib/common';
import { resolvePlatform } from '@/app/api/_lib/social';

const log = createLogger('api:social-accounts');

/**
 * `/api/social/accounts/[platform]` — connect (POST) or disconnect (DELETE) a posting account.
 *
 * Same contract as the CMS integrations: fields are validated against the publisher's own
 * declaration, secrets are encrypted at rest and never returned, and the connection is tested
 * with a real API call before it is called "connected". A blank secret field on a re-save keeps
 * the stored value, so updating one setting does not force the operator to paste every key again.
 */

const saveSchema = z.object({
  websiteId: z.string().trim().min(1),
  credentials: z.record(z.string(), z.string().max(5000)).default({}),
  config: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
  test: z.boolean().default(true),
});

function storedSecrets(value: string | null): Record<string, string> {
  const decrypted = tryDecryptJson<Record<string, unknown>>(value);
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(decrypted ?? {})) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function plainConfig(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : {};
}

export const POST = route<{ platform: string }>(async ({ user, request, params }) => {
  const platform = resolvePlatform(params.platform);
  const body = await readBody(request, saveSchema);
  await assertNotReadOnly();
  const website = await requireScopedWebsite(user, body.websiteId);

  const info = publisherInfo(platform);
  const publisher = getPublisher(platform);
  if (!info || !publisher) {
    throw new ValidationError(`${platform} has no posting API here; posts for it are prepared for you to publish by hand.`);
  }

  const existing = await prisma.socialAccount.findUnique({
    where: { websiteId_platform: { websiteId: website.id, platform } },
  });

  const credentialKeys = new Set(info.credentialFields.map((field) => field.key));
  const credentials = storedSecrets(existing?.credentials ?? null);
  for (const [key, value] of Object.entries(body.credentials)) {
    if (credentialKeys.has(key) && value.trim()) credentials[key] = value.trim();
  }

  const configKeys = new Set(info.configFields.map((field) => field.key));
  const config = plainConfig(existing?.config ?? null);
  for (const [key, value] of Object.entries(body.config ?? {})) {
    if (!configKeys.has(key)) continue;
    if (typeof value === 'string' && !value.trim()) delete config[key];
    else config[key] = typeof value === 'string' ? value.trim() : value;
  }

  const missing = [
    ...info.credentialFields.filter((field) => field.required && !credentials[field.key]),
    ...info.configFields.filter((field) => field.required && (config[field.key] === undefined || config[field.key] === '')),
  ].map((field) => field.label);
  if (missing.length > 0) {
    throw new ValidationError(`Missing required ${info.label} fields: ${missing.join(', ')}.`);
  }

  let test: { ok: boolean; handle: string | null; displayName: string | null; message: string } | null = null;
  if (body.test) {
    try {
      test = await publisher.test({ credentials, config });
    } catch (err) {
      test = { ok: false, handle: null, displayName: null, message: errorMessage(err) };
    }
  }

  const now = new Date();
  const ok = test === null || test.ok;
  const data = {
    credentials: encryptJson(credentials),
    config: json(config),
    status: ok ? ('CONNECTED' as const) : ('ERROR' as const),
    lastError: ok ? null : truncate(test?.message ?? 'Connection test failed', 1_000),
    ...(test?.ok ? { handle: test.handle, displayName: test.displayName, lastTestedAt: now } : {}),
    ...(test && !test.ok ? { lastTestedAt: now } : {}),
  };

  const row = await prisma.socialAccount.upsert({
    where: { websiteId_platform: { websiteId: website.id, platform } },
    create: { websiteId: website.id, platform, ...data },
    update: data,
  });

  log.info('social account saved', { websiteId: website.id, platform, ok, tested: test !== null });
  return {
    account: {
      id: row.id,
      platform: row.platform,
      status: row.status,
      handle: row.handle,
      displayName: row.displayName,
      lastError: row.lastError,
      lastTestedAt: row.lastTestedAt,
    },
    test,
    storedFields: Object.keys(credentials),
  };
});

const deleteQuery = z.object({ websiteId: z.string().trim().min(1) });

export const DELETE = route<{ platform: string }>(async ({ user, request, params }) => {
  const platform = resolvePlatform(params.platform);
  const query = readQuery(request, deleteQuery);
  await assertNotReadOnly();
  const website = await requireScopedWebsite(user, query.websiteId);

  const existing = await prisma.socialAccount.findUnique({
    where: { websiteId_platform: { websiteId: website.id, platform } },
    select: { id: true },
  });
  if (!existing) return { platform, status: 'NOT_CONFIGURED' };

  // The row is kept (posts reference it) but holds no secret any more; scheduled posts on this
  // platform fall back to "post by hand" at publish time.
  await prisma.socialAccount.update({
    where: { id: existing.id },
    data: { credentials: null, status: 'NOT_CONFIGURED', handle: null, displayName: null, lastError: null },
  });
  return { platform, status: 'NOT_CONFIGURED' };
});
