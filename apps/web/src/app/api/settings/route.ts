import { z } from 'zod';
import { getAppSetting, prisma, setAppSetting } from '@seo/db';
import { ValidationError, createLogger, env } from '@seo/shared';
import {
  APP_SETTING_KEYS,
  APP_SETTING_PROVIDER_KEY,
  DEFAULT_MODELS,
  MODEL_ROLES,
  PROVIDER_ENV_VAR,
  getAvailableProviders,
  getMonthlySpend,
  isAiAvailable,
  isProviderName,
  resolveModel,
  type ModelRole,
  type ProviderName,
} from '@seo/ai';
import { readBody, route } from '@/lib/api';
import { ADMIN_ROLES, READ_ONLY_SETTING_KEY, requireRole } from '@/app/api/_lib/common';

const log = createLogger('api:settings');

/**
 * `/api/settings` — installation-wide configuration.
 *
 * Only what an operator can actually change from the UI is writable here. The install-wide AI
 * budget is deliberately read-only: it is enforced from `AI_MONTHLY_BUDGET_USD` by the budget
 * guard, and offering a field that the guard would ignore would be worse than offering none.
 * Per-site caps live on `WebsiteSettings`, where they are enforced.
 */

async function readAiSettings() {
  const [provider, ...models] = await Promise.all([
    getAppSetting<string | null>(APP_SETTING_PROVIDER_KEY, null),
    ...MODEL_ROLES.map((role) => getAppSetting<string | null>(APP_SETTING_KEYS[role], null)),
  ]);

  const configured: Record<string, string | null> = {};
  MODEL_ROLES.forEach((role, index) => {
    configured[role] = models[index] ?? null;
  });

  return { provider, models: configured };
}

/** What each role would actually route to right now, so the UI can show the effective choice. */
async function resolveRoutes(): Promise<Record<string, { provider: string; model: string; providerSource: string; modelSource: string } | null>> {
  const routes: Record<string, { provider: string; model: string; providerSource: string; modelSource: string } | null> = {};
  if (!isAiAvailable()) {
    for (const role of MODEL_ROLES) routes[role] = null;
    return routes;
  }
  for (const role of MODEL_ROLES) {
    try {
      const resolved = await resolveModel(role);
      routes[role] = {
        provider: resolved.providerName,
        model: resolved.model,
        providerSource: resolved.providerSource,
        modelSource: resolved.modelSource,
      };
    } catch {
      // A role with no usable provider (e.g. embeddings on an Anthropic-only install).
      routes[role] = null;
    }
  }
  return routes;
}

export const GET = route(async () => {
  const [ai, routes, budget, readOnly, userCount] = await Promise.all([
    readAiSettings(),
    resolveRoutes(),
    getMonthlySpend(null),
    getAppSetting<boolean>(READ_ONLY_SETTING_KEY, false),
    prisma.user.count(),
  ]);

  return {
    ai: {
      ...ai,
      defaults: DEFAULT_MODELS,
      roles: MODEL_ROLES,
      providers: getAvailableProviders().map((provider) => ({
        name: provider.name,
        configured: provider.configured,
        supportsEmbeddings: provider.supportsEmbeddings,
        envVar: provider.envVar,
      })),
      resolved: routes,
      available: isAiAvailable(),
    },
    budget: {
      ...budget,
      /** The install-wide cap is environment-driven and cannot be edited from the UI. */
      editable: false,
      envVar: 'AI_MONTHLY_BUDGET_USD',
      note: 'Per-site caps are set on each website (Settings → Automation) and are enforced separately.',
    },
    app: {
      demoMode: env.demoMode,
      readOnly: readOnly === true || env.demoMode,
      readOnlySource: env.demoMode ? 'DEMO_MODE' : 'setting',
      allowSignup: env.allowSignup,
      appUrl: env.appUrl,
      userCount,
    },
  };
});

const patchSchema = z
  .object({
    aiProvider: z.string().trim().max(40).nullable().optional(),
    reasoningModel: z.string().trim().max(120).nullable().optional(),
    fastModel: z.string().trim().max(120).nullable().optional(),
    writingModel: z.string().trim().max(120).nullable().optional(),
    embeddingModel: z.string().trim().max(120).nullable().optional(),
    /** Blocks every write that would change a live site or this configuration. */
    readOnly: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

export const PATCH = route(async ({ user, request }) => {
  const body = await readBody(request, patchSchema);
  requireRole(user, ADMIN_ROLES);

  if (env.demoMode) {
    throw new ValidationError('This installation runs in demo mode; global settings are read-only.');
  }

  const warnings: string[] = [];

  if (body.aiProvider !== undefined) {
    const raw = body.aiProvider?.trim() || null;
    let value: ProviderName | null = null;
    if (raw !== null) {
      if (!isProviderName(raw)) {
        throw new ValidationError(
          `Unknown AI provider "${raw}". Valid values: ${Object.keys(PROVIDER_ENV_VAR).join(', ')}.`,
        );
      }
      value = raw;
    }
    if (value && !getAvailableProviders().some((p) => p.name === value && p.configured)) {
      // Stored preferences degrade gracefully in the router, so this is a warning, not an error:
      // an operator often sets the provider just before adding the key.
      warnings.push(
        `${value} has no API key yet (${PROVIDER_ENV_VAR[value]}); routing falls back to a configured provider until it is set.`,
      );
    }
    await setAppSetting(APP_SETTING_PROVIDER_KEY, value);
  }

  const modelUpdates: Array<[ModelRole, string | null | undefined]> = [
    ['reasoning', body.reasoningModel],
    ['fast', body.fastModel],
    ['writing', body.writingModel],
    ['embedding', body.embeddingModel],
  ];
  for (const [role, raw] of modelUpdates) {
    if (raw === undefined) continue;
    // An empty string means "clear the override and fall back to the built-in default".
    await setAppSetting(APP_SETTING_KEYS[role], raw?.trim() || null);
  }

  if (body.readOnly !== undefined) {
    await setAppSetting(READ_ONLY_SETTING_KEY, body.readOnly);
  }

  log.info('global settings updated', { userId: user.id, fields: Object.keys(body) });

  const [ai, routes, readOnly] = await Promise.all([
    readAiSettings(),
    resolveRoutes(),
    getAppSetting<boolean>(READ_ONLY_SETTING_KEY, false),
  ]);

  return { ai: { ...ai, resolved: routes }, app: { readOnly }, warnings };
});
