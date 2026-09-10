import { z } from 'zod';
import { IntegrationProvider, IntegrationStatus, prisma } from '@seo/db';
import { errorMessage } from '@seo/shared';
import { getAdapterTypeInfo, testAdapter } from '@seo/integrations/adapters/registry';
import { findGoogleIntegration, markIntegrationStatus } from '@seo/integrations/google/oauth';
import { listProperties } from '@seo/integrations/google/search-console';
import { listGa4Properties } from '@seo/integrations/google/analytics';
import { isBingConfigured, listBingSites } from '@seo/integrations/bing/webmaster';
import { readBody, requireWebsite, route } from '@/lib/api';
import { isGoogleProvider, resolveProvider } from '@/app/api/_lib/integrations';

/**
 * `POST /api/integrations/[provider]/test` — a real authenticated round-trip.
 *
 * Every branch performs an actual call the product depends on (list properties, list sites, the
 * adapter's own `testConnection`) rather than checking that a row exists: "connected" has to
 * mean the next sync will work, not that someone once pasted a token. The outcome is written
 * back to the row so the settings screen and the executor agree.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
});

export const POST = route<{ provider: string }>(async ({ user, request, params }) => {
  const provider = resolveProvider(params.provider);
  const body = await readBody(request, bodySchema);
  const website = await requireWebsite(user.id, body.websiteId);

  if (getAdapterTypeInfo(provider)) {
    const result = await testAdapter(website.id, { provider });
    return { provider, ...result };
  }

  if (provider === IntegrationProvider.BING_WEBMASTER) {
    if (!isBingConfigured()) {
      return {
        provider,
        ok: false,
        error: 'BING_API_KEY is not set on this installation.',
        warnings: [],
      };
    }
    try {
      // The key is install-wide, so this proves the key works and shows which properties it
      // can see — the site match itself is made when a property is selected.
      const sites = await listBingSites();
      return {
        provider,
        ok: true,
        detail: `${sites.length} site(s) visible to the configured Bing account.`,
        sites,
        warnings: sites.some((site) => site.domain === website.domain)
          ? []
          : [`No Bing property matches ${website.domain}. Verify the site in Bing Webmaster Tools.`],
      };
    } catch (err) {
      return { provider, ok: false, error: errorMessage(err), warnings: [] };
    }
  }

  // Adapters and Bing are handled above; anything left must be one of the two Google grants.
  if (!isGoogleProvider(provider)) {
    return { provider, ok: false, error: `${provider} has no connection test.`, warnings: [] };
  }

  const integration = await findGoogleIntegration(website.id, provider);
  if (!integration) {
    return {
      provider,
      ok: false,
      error: `${provider} is not connected for this website.`,
      warnings: [],
    };
  }

  try {
    if (provider === IntegrationProvider.GOOGLE_SEARCH_CONSOLE) {
      const properties = await listProperties(integration.id);
      await markIntegrationStatus(integration.id, IntegrationStatus.CONNECTED);
      await prisma.integration.update({
        where: { id: integration.id },
        data: { lastSyncStatus: 'OK', lastError: null },
      });
      return {
        provider,
        ok: true,
        detail: `${properties.length} Search Console propert${properties.length === 1 ? 'y' : 'ies'} readable.`,
        properties,
        warnings: properties.length === 0 ? ['The connected account can read no properties.'] : [],
      };
    }

    const properties = await listGa4Properties(integration.id);
    await markIntegrationStatus(integration.id, IntegrationStatus.CONNECTED);
    return {
      provider,
      ok: true,
      detail: `${properties.length} GA4 propert${properties.length === 1 ? 'y' : 'ies'} readable.`,
      properties,
      warnings: properties.length === 0 ? ['The connected account can read no GA4 properties.'] : [],
    };
  } catch (err) {
    const message = errorMessage(err);
    await markIntegrationStatus(integration.id, IntegrationStatus.ERROR, message);
    return { provider, ok: false, error: message, warnings: [] };
  }
});
