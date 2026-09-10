import 'server-only';
import { IntegrationProvider } from '@seo/db';
import { ValidationError } from '@seo/shared';

/**
 * URL-friendly provider aliases.
 *
 * The Prisma enum values are SCREAMING_SNAKE and ugly in a path, and the product's own
 * documentation talks about "wordpress" and "gsc". Both forms resolve here so
 * `/api/integrations/wordpress` and `/api/integrations/WORDPRESS` are the same endpoint.
 */
const ALIASES: Record<string, IntegrationProvider> = {
  gsc: IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  'search-console': IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  'google-search-console': IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  ga4: IntegrationProvider.GOOGLE_ANALYTICS_4,
  analytics: IntegrationProvider.GOOGLE_ANALYTICS_4,
  'google-analytics': IntegrationProvider.GOOGLE_ANALYTICS_4,
  'google-analytics-4': IntegrationProvider.GOOGLE_ANALYTICS_4,
  bing: IntegrationProvider.BING_WEBMASTER,
  'bing-webmaster': IntegrationProvider.BING_WEBMASTER,
  wordpress: IntegrationProvider.WORDPRESS,
  wp: IntegrationProvider.WORDPRESS,
  git: IntegrationProvider.GIT,
  github: IntegrationProvider.GIT,
  webhook: IntegrationProvider.WEBHOOK,
  shopify: IntegrationProvider.SHOPIFY,
  webflow: IntegrationProvider.WEBFLOW,
};

export function resolveProvider(value: string): IntegrationProvider {
  const raw = value.trim();
  const upper = raw.toUpperCase().replace(/-/g, '_');
  const enumMatch = Object.values(IntegrationProvider).find((provider) => provider === upper);
  if (enumMatch) return enumMatch;

  const alias = ALIASES[raw.toLowerCase()];
  if (alias) return alias;

  throw new ValidationError(
    `Unknown integration provider "${value}". Valid values: ${[
      ...Object.values(IntegrationProvider),
      ...Object.keys(ALIASES),
    ].join(', ')}.`,
  );
}

export const GOOGLE_PROVIDERS: IntegrationProvider[] = [
  IntegrationProvider.GOOGLE_SEARCH_CONSOLE,
  IntegrationProvider.GOOGLE_ANALYTICS_4,
];

export function isGoogleProvider(
  provider: IntegrationProvider,
): provider is typeof IntegrationProvider.GOOGLE_SEARCH_CONSOLE | typeof IntegrationProvider.GOOGLE_ANALYTICS_4 {
  return GOOGLE_PROVIDERS.includes(provider);
}

/** Cookie binding the OAuth callback to the browser that started the flow. */
export const OAUTH_NONCE_COOKIE = 'seo_os_oauth_nonce';
