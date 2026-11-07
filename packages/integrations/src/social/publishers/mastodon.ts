import { createHash } from 'node:crypto';
import { httpRequest, type HttpRequestOptions } from '../../adapters/http';
import { readArray, readNumber, readRecord, readString } from '../../serp/http';
import { SocialSourceError, type PostMetrics, type PublishResult, type SocialAccountSecrets, type SocialPublisher } from '../types';
import { assertWithinLimit, configString, httpFailure, requireCredential } from './shared';

/**
 * Mastodon publisher — the instance's REST API with a personal access token.
 *
 * Federation means a thread found on another server has no id on ours: replying first asks our
 * instance to resolve the remote URL into a local status. Every create carries an
 * `Idempotency-Key` so a retried job after a timeout cannot double-post.
 */

const LABEL = 'Mastodon';

function instance(secrets: SocialAccountSecrets): string {
  const url = configString(secrets, 'instanceUrl');
  if (!url) throw new SocialSourceError('NOT_CONFIGURED', 'Mastodon needs the instance URL (e.g. https://mastodon.social).');
  return url.replace(/\/+$/, '');
}

async function api(
  secrets: SocialAccountSecrets,
  path: string,
  operation: string,
  opts: HttpRequestOptions = {},
): Promise<unknown> {
  const token = requireCredential(secrets, 'accessToken', LABEL);
  const res = await httpRequest(`${instance(secrets)}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) },
  });
  if (!res.ok) throw httpFailure(res, LABEL, operation);
  return res.body;
}

/** Our instance's id for a status that may live on another server. */
async function resolveStatusId(secrets: SocialAccountSecrets, target: { externalId: string; url: string }): Promise<string> {
  const found = readRecord(
    await api(secrets, '/api/v2/search', 'status lookup', {
      query: { q: target.url || target.externalId, resolve: true, type: 'statuses', limit: 1 },
    }),
  );
  const id = readString(readRecord(readArray(found?.statuses)[0])?.id);
  if (!id) {
    throw new SocialSourceError('NOT_FOUND', 'Our Mastodon instance could not resolve the post being replied to (it may be deleted or on a blocked server).');
  }
  return id;
}

export const mastodonPublisher: SocialPublisher = {
  platform: 'MASTODON',
  label: LABEL,
  setupHelp:
    'On your instance open Preferences → Development → New application with the scopes read:statuses and write:statuses, then copy "Your access token".',
  credentialFields: [{ key: 'accessToken', label: 'Access token', required: true, secret: true }],
  configFields: [
    { key: 'instanceUrl', label: 'Instance URL', required: true, secret: false, placeholder: 'https://mastodon.social' },
  ],
  capabilities: { original: true, reply: true, title: false, metrics: true, remove: true },

  async test(secrets) {
    const account = readRecord(await api(secrets, '/api/v1/accounts/verify_credentials', 'credential check'));
    const acct = readString(account?.acct);
    if (!acct) return { ok: false, handle: null, displayName: null, message: 'Mastodon returned no account for this token.' };
    const host = new URL(instance(secrets)).hostname;
    const handle = acct.includes('@') ? `@${acct}` : `@${acct}@${host}`;
    return { ok: true, handle, displayName: readString(account?.display_name) || acct, message: `Connected as ${handle}.` };
  },

  async publish(input, secrets): Promise<PublishResult> {
    assertWithinLimit('MASTODON', input.body);
    const body: Record<string, unknown> = { status: input.body, visibility: 'public' };
    if (input.kind === 'REPLY') {
      if (!input.replyTo) throw new SocialSourceError('BAD_INPUT', 'A Mastodon reply needs the post being answered.');
      body.in_reply_to_id = await resolveStatusId(secrets, input.replyTo);
    }
    const key = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const status = readRecord(
      await api(secrets, '/api/v1/statuses', 'post', { method: 'POST', body, headers: { 'idempotency-key': key } }),
    );
    const id = readString(status?.id);
    if (!id) throw new SocialSourceError('UPSTREAM', 'Mastodon accepted the post but returned no id.');
    return { externalId: id, url: readString(status?.url) || null };
  },

  async metrics(externalIds, secrets) {
    const out: Record<string, PostMetrics> = {};
    for (const id of externalIds) {
      try {
        const status = readRecord(await api(secrets, `/api/v1/statuses/${encodeURIComponent(id)}`, 'status read'));
        out[id] = {
          likes: readNumber(status?.favourites_count),
          reposts: readNumber(status?.reblogs_count),
          comments: readNumber(status?.replies_count),
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

  async remove(externalId, secrets) {
    await api(secrets, `/api/v1/statuses/${encodeURIComponent(externalId)}`, 'delete', { method: 'DELETE' });
  },
};
