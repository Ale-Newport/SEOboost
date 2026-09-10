import { getAppSetting } from '@seo/db';
import {
  APP_SETTING_KEYS,
  APP_SETTING_PROVIDER_KEY,
  DEFAULT_MODELS,
  MODEL_ROLES,
  getAvailableProviders,
  isAiAvailable,
} from '@seo/ai';
import { route } from '@/lib/api';

/**
 * `GET /api/settings/ai/providers` — the provider matrix for the model picker.
 *
 * Entirely offline: provider availability is an env check and the model lists are static, so
 * this is safe to call on every settings render and returns the same answer with no network.
 * A provider with no key is listed as unconfigured with the env var to set, never hidden — the
 * operator needs to see what they could turn on.
 */
export const GET = route(async () => {
  const [selectedProvider, ...selectedModels] = await Promise.all([
    getAppSetting<string | null>(APP_SETTING_PROVIDER_KEY, null),
    ...MODEL_ROLES.map((role) => getAppSetting<string | null>(APP_SETTING_KEYS[role], null)),
  ]);

  const models: Record<string, string | null> = {};
  MODEL_ROLES.forEach((role, index) => {
    models[role] = selectedModels[index] ?? null;
  });

  return {
    available: isAiAvailable(),
    roles: MODEL_ROLES,
    providers: getAvailableProviders(),
    defaults: DEFAULT_MODELS,
    selected: { provider: selectedProvider, models },
  };
});
