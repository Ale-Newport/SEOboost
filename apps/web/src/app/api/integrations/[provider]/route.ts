import { z } from 'zod';
import { IntegrationStatus, json, prisma, readJson } from '@seo/db';
import { ValidationError, createLogger } from '@seo/shared';
import { encryptJson } from '@seo/shared/crypto';
import { getAdapterTypeInfo, testAdapter } from '@seo/integrations/adapters/registry';
import { revokeGoogle } from '@seo/integrations/google/oauth';
import { readBody, readQuery, requireWebsite, route } from '@/lib/api';
import { assertNotReadOnly } from '@/app/api/_lib/common';
import { isGoogleProvider, resolveProvider } from '@/app/api/_lib/integrations';

const log = createLogger('api:integrations');

/**
 * `/api/integrations/[provider]` — connect (POST) and disconnect (DELETE) a per-site integration.
 *
 * Secrets go in and never come back out. The request body is validated against the adapter's
 * own declared credential fields, encrypted with `encryptJson` and written to
 * `Integration.credentials`; the response reports only *which* fields were stored. Google is
 * deliberately not connectable here — it is an OAuth grant, not a pasted secret.
 */

const saveSchema = z.object({
  websiteId: z.string().trim().min(1),
  /** Secret fields, as declared by the adapter's `credentialFields`. */
  credentials: z.record(z.string(), z.string().max(5000)),
  /** Non-secret settings, as declared by the adapter's `configFields`. */
  config: z.record(z.string(), z.union([z.string().max(2000), z.number(), z.boolean()])).optional(),
  /** Run the adapter's authenticated round-trip before reporting success. Defaults to true. */
  test: z.boolean().default(true),
});

export const POST = route<{ provider: string }>(async ({ user, request, params }) => {
  const provider = resolveProvider(params.provider);
  const body = await readBody(request, saveSchema);
  await assertNotReadOnly();
  const website = await requireWebsite(user.id, body.websiteId);

  const info = getAdapterTypeInfo(provider);
  if (!info) {
    throw new ValidationError(
      isGoogleProvider(provider)
        ? 'Google is connected through OAuth. Start at GET /api/integrations/google/authorize.'
        : `${provider} has no per-site credentials; it is configured through the environment.`,
    );
  }

  const missing = info.credentialFields
    .filter((field) => field.required && !body.credentials[field.key]?.trim())
    .map((field) => `${field.key} (${field.label})`);
  if (missing.length > 0) {
    throw new ValidationError(`Missing required ${info.label} credentials: ${missing.join(', ')}.`);
  }

  const missingConfig = info.configFields
    .filter((field) => field.required && body.config?.[field.key] === undefined)
    .map((field) => `${field.key} (${field.label})`);
  if (missingConfig.length > 0) {
    throw new ValidationError(`Missing required ${info.label} settings: ${missingConfig.join(', ')}.`);
  }

  // Only the fields the adapter declares are kept: an unexpected key in the body is far more
  // likely to be a mistake than a secret worth storing.
  const credentialKeys = new Set(info.credentialFields.map((field) => field.key));
  const credentials: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.credentials)) {
    if (credentialKeys.has(key) && value.trim()) credentials[key] = value;
  }

  const configKeys = new Set(info.configFields.map((field) => field.key));
  const existing = await prisma.integration.findUnique({
    where: { websiteId_provider: { websiteId: website.id, provider } },
    select: { id: true, config: true },
  });
  const mergedConfig = { ...readJson<Record<string, unknown>>(existing?.config, {}) };
  for (const [key, value] of Object.entries(body.config ?? {})) {
    if (configKeys.has(key)) mergedConfig[key] = value;
  }

  const row = await prisma.integration.upsert({
    where: { websiteId_provider: { websiteId: website.id, provider } },
    create: {
      websiteId: website.id,
      provider,
      status: IntegrationStatus.CONNECTED,
      credentials: encryptJson(credentials),
      config: json(mergedConfig),
      lastError: null,
    },
    update: {
      status: IntegrationStatus.CONNECTED,
      credentials: encryptJson(credentials),
      config: json(mergedConfig),
      lastError: null,
    },
    select: { id: true, provider: true, status: true },
  });

  const test = body.test ? await testAdapter(website.id, { provider }) : null;

  log.info('integration credentials saved', {
    websiteId: website.id,
    provider,
    tested: body.test,
    ok: test?.ok,
  });

  return {
    integrationId: row.id,
    provider: row.provider,
    // `testAdapter` already wrote the real status to the row; report that, not our optimistic one.
    status: test ? (test.ok ? IntegrationStatus.CONNECTED : IntegrationStatus.ERROR) : row.status,
    storedCredentialFields: Object.keys(credentials),
    config: mergedConfig,
    test,
  };
});

const deleteQuerySchema = z.object({
  websiteId: z.string().trim().min(1),
});

export const DELETE = route<{ provider: string }>(async ({ user, request, params }) => {
  const provider = resolveProvider(params.provider);
  const query = readQuery(request, deleteQuerySchema);
  await assertNotReadOnly();
  const website = await requireWebsite(user.id, query.websiteId);

  const row = await prisma.integration.findUnique({
    where: { websiteId_provider: { websiteId: website.id, provider } },
    select: { id: true },
  });
  if (!row) {
    return { provider, disconnected: false, message: 'That integration was not connected.' };
  }

  if (isGoogleProvider(provider)) {
    // Revoking at Google is best-effort; the local credentials are cleared either way, or a
    // broken grant could never be disconnected.
    const result = await revokeGoogle(row.id);
    log.info('google integration disconnected', {
      websiteId: website.id,
      provider,
      revokedAtGoogle: result.ok ? result.data.revokedAtGoogle : false,
    });
    return {
      provider,
      disconnected: true,
      revokedAtProvider: result.ok ? result.data.revokedAtGoogle : false,
    };
  }

  await prisma.integration.update({
    where: { id: row.id },
    data: {
      credentials: null,
      status: IntegrationStatus.NOT_CONFIGURED,
      accountEmail: null,
      expiresAt: null,
      lastError: null,
    },
  });

  log.info('integration disconnected', { websiteId: website.id, provider });
  return { provider, disconnected: true, revokedAtProvider: false };
});
