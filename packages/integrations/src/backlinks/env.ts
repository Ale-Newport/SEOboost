/**
 * Provider-local optional keys for the paid backlink APIs.
 *
 * These are deliberately NOT in `packages/shared/src/env.ts`. That file is the platform's env
 * *contract*: keys the core product boots on, or that more than one package reads. Ahrefs,
 * Semrush and Moz are drop-in commercial add-ons that only this folder ever touches, and
 * adding one getter per vendor there would grow the shared contract (and `.env.example`, and
 * the settings screen's required-env list) for integrations most installs never enable.
 *
 * The degradation path stays local and identical to the shared one: no key ⇒
 * `isConfigured() === false` ⇒ `IntegrationNotConfiguredError` if the provider is called anyway.
 */

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export const backlinkEnv = {
  get ahrefsApiKey(): string | undefined {
    return optional('AHREFS_API_KEY');
  },
  get semrushApiKey(): string | undefined {
    return optional('SEMRUSH_API_KEY');
  },
  get mozAccessId(): string | undefined {
    return optional('MOZ_ACCESS_ID');
  },
  get mozSecretKey(): string | undefined {
    return optional('MOZ_SECRET_KEY');
  },
} as const;
