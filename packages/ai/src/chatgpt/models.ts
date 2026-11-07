import type { ModelDescriptor, ModelRole } from '../types';
import { CHATGPT_MODELS_URL } from './constants';
import { classifyResponsesError } from './errors';

/**
 * Which models a ChatGPT plan can use from this app.
 *
 * The list is per account and per plan, so it is fetched with the user's token (never
 * hard-coded) and stored with the connection; `visibility == "list"` entries are the ones OpenAI
 * intends apps to show, in the server's own order.
 */

export interface ChatGptModel {
  slug: string;
  displayName: string;
}

export function parseModelList(body: unknown): ChatGptModel[] {
  const record = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const entries = Array.isArray(record.models) ? record.models : Array.isArray(record.data) ? record.data : [];
  const out: ChatGptModel[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const slug = typeof row.slug === 'string' ? row.slug : typeof row.id === 'string' ? row.id : null;
    if (!slug) continue;
    // Entries without a visibility field are kept: an absent flag is not a "hidden" flag.
    if (row.visibility !== undefined && row.visibility !== 'list') continue;
    out.push({ slug, displayName: typeof row.display_name === 'string' ? row.display_name : slug });
  }
  return out;
}

export async function fetchChatGptModels(accessToken: string): Promise<ChatGptModel[]> {
  let response: Response;
  try {
    response = await fetch(CHATGPT_MODELS_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw classifyResponsesError({ status: null, code: null, message: err instanceof Error ? err.message : String(err) });
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null ? ((body as Record<string, unknown>).error as Record<string, unknown> | undefined) : undefined;
    throw classifyResponsesError({
      status: response.status,
      code: typeof error?.code === 'string' ? error.code : null,
      message: typeof error?.message === 'string' ? error.message : text.slice(0, 200),
    });
  }
  return parseModelList(body);
}

/**
 * Built-in routing for a plan: the first listed model for reasoning and writing (the server
 * orders by preference), the first "mini" model for high-volume fast work, nothing for
 * embeddings — plan usage only serves the Responses API, so vectors come from another
 * provider or degrade to lexical similarity, exactly as on an Anthropic-only install.
 */
export function pickDefaultModels(models: readonly ChatGptModel[]): Record<ModelRole, string | null> {
  const first = models[0]?.slug ?? null;
  const mini = models.find((model) => /mini/i.test(model.slug))?.slug ?? first;
  return { reasoning: first, writing: first, fast: mini, embedding: null };
}

export function toModelDescriptors(models: readonly ChatGptModel[]): ModelDescriptor[] {
  const defaults = pickDefaultModels(models);
  return models.map((model) => {
    const roles: ModelRole[] = [];
    if (model.slug === defaults.reasoning) roles.push('reasoning', 'writing');
    if (model.slug === defaults.fast) roles.push('fast');
    return { id: model.slug, label: model.displayName, roles: roles.length ? roles : ['reasoning', 'writing', 'fast'] };
  });
}
