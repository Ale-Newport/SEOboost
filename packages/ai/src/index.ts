/**
 * `@seo/ai` — provider abstraction, prompt registry, structured output, embeddings and cost
 * control for the whole platform.
 *
 * Callers should go through `ai.generate` / `ai.generateStructured` / `embedTexts`. The
 * provider adapters are intentionally not exported: routing, the budget guard and `AiUsage`
 * accounting all live in `client.ts`, and a direct adapter call would bypass every one of them.
 */

export * from './types';
export * from './pricing';
export * from './json-schema';
export * from './structured';
export * from './registry';
export * from './usage';
export * from './embeddings';
export * from './client';
export * from './prompts';
