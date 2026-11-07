import { httpRequest, type HttpRequestOptions } from '../../adapters/http';
import { readNumber, readRecord, readString } from '../../serp/http';
import { SocialSourceError, type PostMetrics, type PublishResult, type SocialAccountSecrets, type SocialPublisher } from '../types';
import { assertWithinLimit, httpFailure, requireCredential } from './shared';

/**
 * Dev.to (Forem) publisher — long-form cross-posts.
 *
 * Every article is published with `canonical_url` pointing at the original page, so search
 * engines consolidate the duplicate onto our site instead of ranking Dev.to's copy above it.
 * That is the whole point of cross-posting; an article without a canonical is refused.
 */

const LABEL = 'Dev.to';
const API = 'https://dev.to/api';

async function api(secrets: SocialAccountSecrets, path: string, operation: string, opts: HttpRequestOptions = {}): Promise<unknown> {
  const res = await httpRequest(`${API}${path}`, {
    ...opts,
    headers: { 'api-key': requireCredential(secrets, 'apiKey', LABEL), accept: 'application/vnd.forem.api-v1+json', ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw httpFailure(res, LABEL, operation);
  return res.body;
}

/** Dev.to accepts at most four tags, lowercase alphanumeric only. */
export function devtoTags(tags: readonly string[]): string[] {
  const clean = tags
    .map((tag) => tag.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  return [...new Set(clean)].slice(0, 4);
}

export const devtoPublisher: SocialPublisher = {
  platform: 'DEVTO',
  label: LABEL,
  setupHelp: 'Generate an API key at https://dev.to/settings/extensions ("DEV Community API Keys").',
  credentialFields: [{ key: 'apiKey', label: 'API key', required: true, secret: true }],
  configFields: [],
  capabilities: { original: true, reply: false, title: true, metrics: true, remove: true },

  async test(secrets) {
    const me = readRecord(await api(secrets, '/users/me', 'credential check'));
    const username = readString(me?.username);
    if (!username) return { ok: false, handle: null, displayName: null, message: 'Dev.to returned no user for this key.' };
    return { ok: true, handle: `@${username}`, displayName: readString(me?.name) || username, message: `Connected as @${username}.` };
  },

  async publish(input, secrets): Promise<PublishResult> {
    if (input.kind === 'REPLY') throw new SocialSourceError('UNSUPPORTED', 'Dev.to\'s API cannot post comments.');
    const title = input.title?.trim();
    if (!title) throw new SocialSourceError('BAD_INPUT', 'Dev.to articles need a title.');
    const canonical = input.canonicalUrl ?? input.linkUrl;
    if (!canonical) {
      throw new SocialSourceError('BAD_INPUT', 'A Dev.to cross-post needs the original page as its canonical URL, or it competes with our own page in search.');
    }
    assertWithinLimit('DEVTO', input.body);
    const article = readRecord(
      await api(secrets, '/articles', 'publish', {
        method: 'POST',
        body: {
          article: { title, body_markdown: input.body, published: true, canonical_url: canonical, tags: devtoTags(input.tags) },
        },
      }),
    );
    const id = readString(article?.id);
    if (!id) throw new SocialSourceError('UPSTREAM', 'Dev.to accepted the article but returned no id.');
    return { externalId: id, url: readString(article?.url) || null };
  },

  async metrics(externalIds, secrets) {
    const out: Record<string, PostMetrics> = {};
    for (const id of externalIds) {
      try {
        const article = readRecord(await api(secrets, `/articles/${encodeURIComponent(id)}`, 'article read'));
        out[id] = {
          likes: readNumber(article?.public_reactions_count ?? article?.positive_reactions_count),
          comments: readNumber(article?.comments_count),
          live: true,
        };
      } catch (err) {
        if (err instanceof SocialSourceError && err.code === 'NOT_FOUND') {
          out[id] = { live: false };
          continue;
        }
        throw err;
      }
    }
    return out;
  },

  /** The API cannot delete an article; unpublishing it is the closest reversible equivalent. */
  async remove(externalId, secrets) {
    await api(secrets, `/articles/${encodeURIComponent(externalId)}`, 'unpublish', {
      method: 'PUT',
      body: { article: { published: false } },
    });
  },
};
