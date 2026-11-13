import { z } from 'zod';
import { detectMailPreset } from '@seo/integrations';
import { readQuery, route } from '@/lib/api';

/**
 * `GET /api/mail/accounts/detect?email=` — the provider preset for an address.
 * Pure lookup by domain: no DNS, no connection, nothing leaves the server.
 */
const query = z.object({ email: z.string().trim().max(320) });

export const GET = route(async ({ request }) => {
  const { email } = readQuery(request, query);
  const preset = detectMailPreset(email);
  return {
    id: preset.id,
    label: preset.label,
    config: preset.config,
    appPasswordUrl: preset.appPasswordUrl,
    steps: preset.steps,
  };
});
