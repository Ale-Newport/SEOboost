import { APP_SETTING_KEYS, APP_SETTING_PROVIDER_KEY } from '@seo/ai/registry';
import { prisma } from '../client';
import { json } from '../helpers';
import { ok, type SeedStepResult } from './types';

/**
 * Global routing placeholders.
 *
 * The value is an empty string, not a model id, on purpose: `resolveModel()` treats blank as
 * "unset" and falls through to the built-in per-provider defaults, which move with the code.
 * Pinning a concrete model here would silently freeze every install on whatever was current the
 * day it was seeded. Seeding the *keys* is still worth doing — it means Settings → AI renders the
 * routing rows on a fresh database instead of an empty panel.
 */
const AI_ROUTING_DEFAULTS: Array<{ key: string; value: string; note: string }> = [
  {
    key: APP_SETTING_PROVIDER_KEY,
    value: '',
    note: 'Global AI provider. Blank = use the first configured provider (anthropic → openai → gemini).',
  },
  {
    key: APP_SETTING_KEYS.reasoning,
    value: '',
    note: 'Model for analysis and planning. Blank = provider default.',
  },
  { key: APP_SETTING_KEYS.fast, value: '', note: 'Model for cheap, high-volume calls. Blank = provider default.' },
  { key: APP_SETTING_KEYS.writing, value: '', note: 'Model for content drafting. Blank = provider default.' },
  { key: APP_SETTING_KEYS.embedding, value: '', note: 'Embedding model. Blank = provider default.' },
];

/**
 * Write the global defaults, but never overwrite a value the operator already chose — the seed is
 * expected to be re-run after upgrades and it must not silently reset a configured install.
 */
export async function ensureAppSettings(): Promise<SeedStepResult> {
  let created = 0;
  let preserved = 0;

  for (const setting of AI_ROUTING_DEFAULTS) {
    const existing = await prisma.appSetting.findUnique({ where: { key: setting.key } });
    if (existing) {
      preserved++;
      continue;
    }
    await prisma.appSetting.create({ data: { key: setting.key, value: json(setting.value) } });
    created++;
  }

  // Documentation for the settings UI, refreshed every run because it is ours, not the operator's.
  await prisma.appSetting.upsert({
    where: { key: 'ai.routingNotes' },
    create: {
      key: 'ai.routingNotes',
      value: json(Object.fromEntries(AI_ROUTING_DEFAULTS.map((s) => [s.key, s.note]))),
    },
    update: { value: json(Object.fromEntries(AI_ROUTING_DEFAULTS.map((s) => [s.key, s.note]))) },
  });

  return ok(
    preserved > 0
      ? `${created} default(s) created, ${preserved} existing value(s) left untouched`
      : `${created} AI routing default(s) created`,
    { AppSetting: created + 1 },
  );
}
