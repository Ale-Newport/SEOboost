import { z } from 'zod';
import { IntegrationProvider, IntegrationStatus, prisma } from '@seo/db';
import { ConflictError, ValidationError, createLogger, errorMessage } from '@seo/shared';
import {
  findGoogleIntegration,
  markIntegrationStatus,
  patchGoogleConfig,
  readGoogleConfig,
} from '@seo/integrations/google/oauth';
import { listProperties } from '@seo/integrations/google/search-console';
import { listGa4Properties, selectGa4Property } from '@seo/integrations/google/analytics';
import { readBody, readQuery, requireWebsite, route } from '@/lib/api';
import { assertNotReadOnly, skipped } from '@/app/api/_lib/common';

const log = createLogger('api:integrations:google');

/**
 * `/api/integrations/google/properties` — list what the connected account can read, and choose one.
 *
 * A Google grant on its own reports nothing: Search Console needs a property and GA4 needs a
 * property id. Selection is validated against what the account can actually read, so a typo or
 * a property the user lost access to fails here rather than silently producing empty syncs.
 */

const providerSchema = z.enum([
  IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  IntegrationProvider.GOOGLE_ANALYTICS_4,
]);

const listQuerySchema = z.object({
  websiteId: z.string().trim().min(1),
  provider: providerSchema.default(IntegrationProvider.GOOGLE_SEARCH_CONSOLE),
});

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, listQuerySchema);
  const website = await requireWebsite(user.id, query.websiteId);

  const integration = await findGoogleIntegration(website.id, query.provider);
  if (!integration) {
    return skipped(
      `${query.provider} is not connected for this website.`,
      'Start the connection at GET /api/integrations/google/authorize?websiteId=…',
    );
  }

  try {
    const selected = readGoogleConfig(integration.config);
    if (query.provider === IntegrationProvider.GOOGLE_SEARCH_CONSOLE) {
      const properties = await listProperties(integration.id);
      return { provider: query.provider, properties, selected: selected.siteUrl ?? null };
    }
    const properties = await listGa4Properties(integration.id);
    return { provider: query.provider, properties, selected: selected.propertyId ?? null };
  } catch (err) {
    // A revoked or expired grant is a state to display, not a 500.
    log.warn('could not list google properties', {
      websiteId: website.id,
      provider: query.provider,
      error: errorMessage(err),
    });
    return skipped(
      `Google refused the request: ${errorMessage(err)}`,
      'Reconnect the Google account for this website.',
    );
  }
});

const selectSchema = z
  .object({
    websiteId: z.string().trim().min(1),
    provider: providerSchema.default(IntegrationProvider.GOOGLE_SEARCH_CONSOLE),
    /** Search Console property, e.g. `sc-domain:example.com`. */
    siteUrl: z.string().trim().max(500).optional(),
    /** GA4 property resource name, e.g. `properties/123456789`. */
    propertyId: z.string().trim().max(120).optional(),
  })
  .refine((value) => Boolean(value.siteUrl) || Boolean(value.propertyId), {
    message: 'Provide siteUrl (Search Console) or propertyId (GA4).',
  });

export const POST = route(async ({ user, request }) => {
  const body = await readBody(request, selectSchema);
  await assertNotReadOnly();
  const website = await requireWebsite(user.id, body.websiteId);

  const integration = await findGoogleIntegration(website.id, body.provider);
  if (!integration) {
    throw new ConflictError(`${body.provider} is not connected for this website.`);
  }

  if (body.provider === IntegrationProvider.GOOGLE_ANALYTICS_4) {
    if (!body.propertyId) throw new ValidationError('propertyId is required for GA4.');
    const result = await selectGa4Property(integration.id, body.propertyId);
    if (!result.ok) throw new ConflictError(result.error);
    log.info('ga4 property selected', { websiteId: website.id, propertyId: body.propertyId });
    return { provider: body.provider, selected: result.data };
  }

  if (!body.siteUrl) throw new ValidationError('siteUrl is required for Search Console.');

  const properties = await listProperties(integration.id);
  const match = properties.find((property) => property.siteUrl === body.siteUrl);
  if (!match) {
    throw new ConflictError(
      `The connected Google account cannot read "${body.siteUrl}". ` +
        `Available: ${properties.map((property) => property.siteUrl).join(', ') || 'none'}.`,
    );
  }
  if (!match.isVerified) {
    throw new ConflictError(
      `"${match.siteUrl}" is not verified for the connected account, so Search Console will return no data.`,
    );
  }

  const config = await patchGoogleConfig(integration.id, {
    siteUrl: match.siteUrl,
    permissionLevel: match.permissionLevel,
  });
  await markIntegrationStatus(integration.id, IntegrationStatus.CONNECTED);
  await prisma.integration.update({
    where: { id: integration.id },
    data: { externalId: match.siteUrl },
  });

  log.info('search console property selected', { websiteId: website.id, siteUrl: match.siteUrl });
  return { provider: body.provider, selected: match, config };
});
