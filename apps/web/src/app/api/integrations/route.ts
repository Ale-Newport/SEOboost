import { readQuery, route } from '@/lib/api';
import {
  describeEnvironmentIntegrations,
  getIntegrationOverview,
} from '@/server/queries/integrations';
import { resolveScope, websiteScopeSchema } from '@/app/api/_lib/common';

/**
 * `GET /api/integrations` — connection state for a site, and what this installation supports.
 *
 * Without `websiteId` only the environment-level picture is returned, which is what the global
 * settings screen needs. Credentials are never part of any branch of this response: the read
 * model selects columns explicitly and reduces the encrypted envelope to a `hasCredentials`
 * boolean before it leaves the server.
 */

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, websiteScopeSchema);

  if (!query.websiteId) {
    const scope = await resolveScope(user);
    return {
      websiteId: null,
      environment: describeEnvironmentIntegrations(),
      websiteIds: scope.websiteIds,
    };
  }

  const scope = await resolveScope(user, query.websiteId);
  const website = scope.website;
  if (!website) {
    // resolveScope throws for an unknown or unowned id, so this is unreachable in practice.
    return { websiteId: null, environment: describeEnvironmentIntegrations(), websiteIds: [] };
  }

  return getIntegrationOverview(website.id);
});
