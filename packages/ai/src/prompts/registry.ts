import { NotFoundError, createLogger } from '@seo/shared';
import type { PromptTemplate, PromptTemplateMeta, RegisteredPrompt } from './types';

const log = createLogger('ai:prompts');

/** Populated at import time by the template modules; see `prompts/index.ts`. */
const registry = new Map<string, RegisteredPrompt>();

/**
 * Register a template and return it, so a template module can do
 * `export const x = registerPrompt<Vars>({ … })` and be registered by the act of being imported.
 *
 * A duplicate id overwrites rather than throwing: registration happens at module load, and a
 * throw there would take down the whole process (and breaks dev-server hot reload, which
 * re-evaluates the module). The collision is logged loudly instead.
 */
export function registerPrompt<TVars>(template: PromptTemplate<TVars>): PromptTemplate<TVars> {
  const existing = registry.get(template.id);
  if (existing && existing !== (template as RegisteredPrompt)) {
    log.warn('prompt id registered more than once — the later definition wins', {
      id: template.id,
      previousVersion: existing.version,
      version: template.version,
    });
  }
  registry.set(template.id, template);
  return template;
}

/** Look up a template by id. Throws `NotFoundError` — an unknown id is always a bug. */
export function getPrompt(id: string): RegisteredPrompt {
  const template = registry.get(id);
  if (!template) throw new NotFoundError(`Prompt "${id}"`);
  return template;
}

/** Non-throwing lookup, for callers validating an operator-supplied id. */
export function findPrompt(id: string): RegisteredPrompt | null {
  return registry.get(id) ?? null;
}

/** Every registered template, id-sorted. Used by the prompt inspector in Settings. */
export function listPrompts(): RegisteredPrompt[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Metadata only — safe to serialise to the client, unlike the full system prompts. */
export function listPromptMeta(): PromptTemplateMeta[] {
  return listPrompts().map(({ id, version, description, defaultRole }) => ({
    id,
    version,
    description,
    // The system prompt is the valuable part; the inspector fetches it on demand.
    system: '',
    ...(defaultRole ? { defaultRole } : {}),
  }));
}

export function promptIds(): string[] {
  return listPrompts().map((template) => template.id);
}

/**
 * Render a template by id into the `{ system, prompt }` pair `ai.generate` expects.
 * Untyped by construction — prefer importing the template const when the vars are known.
 */
export function renderPrompt(
  id: string,
  vars: unknown,
): { system: string; prompt: string; version: number } {
  const template = getPrompt(id);
  return { system: template.system, prompt: template.render(vars), version: template.version };
}
