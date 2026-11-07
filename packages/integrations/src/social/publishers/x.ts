import { createHmac, randomBytes } from 'node:crypto';
import { httpRequest } from '../../adapters/http';
import { readArray, readNumber, readRecord, readString } from '../../serp/http';
import { SocialSourceError, type PostMetrics, type PublishResult, type SocialAccountSecrets, type SocialPublisher } from '../types';
import { assertWithinLimit, httpFailure, requireCredential } from './shared';

/**
 * X publisher — API v2 with OAuth 1.0a user context.
 *
 * OAuth 1.0a rather than OAuth 2 PKCE because it needs no redirect flow: the four values come
 * straight from the developer portal for the operator's own account and never expire. The
 * signature covers the method, the URL, the query string and the oauth_* parameters — but NOT a
 * JSON body, which is why v2's JSON endpoints can be signed this way at all.
 */

const LABEL = 'X';
const API = 'https://api.x.com';

/** RFC 3986 percent-encoding; `encodeURIComponent` leaves `!'()*` alone, OAuth does not. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface OAuth1Input {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  nonce?: string;
  timestamp?: number;
  /** Form-encoded body parameters, which are signed. JSON bodies are not. */
  extraParams?: Record<string, string>;
}

/** The `Authorization: OAuth …` header for one request. Pure when nonce and timestamp are supplied. */
export function oauth1Header(input: OAuth1Input): string {
  const parsed = new URL(input.url);
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    oauth_nonce: input.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: input.token,
    oauth_version: '1.0',
  };

  const params: Array<[string, string]> = [
    ...Object.entries(oauth),
    ...[...parsed.searchParams.entries()],
    ...Object.entries(input.extraParams ?? {}),
  ].map(([key, value]): [string, string] => [percentEncode(key), percentEncode(value)]);
  params.sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));

  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const base = [
    input.method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(params.map(([key, value]) => `${key}=${value}`).join('&')),
  ].join('&');
  const signingKey = `${percentEncode(input.consumerSecret)}&${percentEncode(input.tokenSecret)}`;
  const signature = createHmac('sha1', signingKey).update(base).digest('base64');

  const header = { ...oauth, oauth_signature: signature };
  return `OAuth ${Object.keys(header)
    .sort()
    .map((key) => `${percentEncode(key)}="${percentEncode(header[key as keyof typeof header])}"`)
    .join(', ')}`;
}

function keys(secrets: SocialAccountSecrets) {
  return {
    consumerKey: requireCredential(secrets, 'apiKey', LABEL),
    consumerSecret: requireCredential(secrets, 'apiKeySecret', LABEL),
    token: requireCredential(secrets, 'accessToken', LABEL),
    tokenSecret: requireCredential(secrets, 'accessTokenSecret', LABEL),
  };
}

/**
 * One request as the connected account: an OAuth 2.0 user token from one-click connection
 * (kept fresh upstream), or OAuth 1.0a signing for keys pasted from the developer portal.
 */
async function signed(
  secrets: SocialAccountSecrets,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
) {
  const url = `${API}${path}`;
  const authorization =
    secrets.credentials.authType === 'oauth2'
      ? `Bearer ${requireCredential(secrets, 'accessToken', LABEL)}`
      : oauth1Header({ method, url, ...keys(secrets) });
  return httpRequest(url, {
    method,
    ...(body !== undefined ? { body } : {}),
    headers: { authorization },
  });
}

export const xPublisher: SocialPublisher = {
  platform: 'X',
  label: LABEL,
  setupHelp:
    'In the X developer portal, give the app "Read and write" permission, then generate the API key/secret and the access token/secret for your own account (regenerate the token after changing permissions).',
  credentialFields: [
    { key: 'apiKey', label: 'API key', required: true, secret: false },
    { key: 'apiKeySecret', label: 'API key secret', required: true, secret: true },
    { key: 'accessToken', label: 'Access token', required: true, secret: true },
    { key: 'accessTokenSecret', label: 'Access token secret', required: true, secret: true },
  ],
  configFields: [],
  capabilities: { original: true, reply: true, title: false, metrics: true, remove: true },

  async test(secrets) {
    const res = await signed(secrets, 'GET', '/2/users/me');
    if (!res.ok) throw httpFailure(res, LABEL, 'credential check');
    const user = readRecord(readRecord(res.body)?.data);
    const username = readString(user?.username);
    if (!username) return { ok: false, handle: null, displayName: null, message: 'X returned no user for these keys.' };
    return { ok: true, handle: `@${username}`, displayName: readString(user?.name) || username, message: `Connected as @${username}.` };
  },

  async publish(input, secrets): Promise<PublishResult> {
    assertWithinLimit('X', input.body);
    const body: Record<string, unknown> = { text: input.body };
    if (input.kind === 'REPLY') {
      const id = input.replyTo?.externalId;
      if (!id || !/^\d+$/.test(id)) throw new SocialSourceError('BAD_INPUT', 'An X reply needs the numeric id of the post being answered.');
      body.reply = { in_reply_to_tweet_id: id };
    }
    const res = await signed(secrets, 'POST', '/2/tweets', body);
    if (!res.ok) throw httpFailure(res, LABEL, 'post');
    const id = readString(readRecord(readRecord(res.body)?.data)?.id);
    if (!id) throw new SocialSourceError('UPSTREAM', 'X accepted the post but returned no id.');
    return { externalId: id, url: `https://x.com/i/web/status/${id}` };
  },

  async metrics(externalIds, secrets) {
    const out: Record<string, PostMetrics> = {};
    for (let i = 0; i < externalIds.length; i += 100) {
      const ids = externalIds.slice(i, i + 100);
      const res = await signed(secrets, 'GET', `/2/tweets?ids=${ids.join(',')}&tweet.fields=public_metrics`);
      // Reading posts back is not included in X's lowest API tiers; no metrics is not a failure.
      if (res.status === 401 || res.status === 403 || res.status === 429) return out;
      if (!res.ok) throw httpFailure(res, LABEL, 'metrics read');
      const seen = new Set<string>();
      for (const tweet of readArray(readRecord(res.body)?.data)) {
        const record = readRecord(tweet);
        const id = readString(record?.id);
        if (!id) continue;
        seen.add(id);
        const m = readRecord(record?.public_metrics);
        out[id] = {
          likes: readNumber(m?.like_count),
          comments: readNumber(m?.reply_count),
          reposts: readNumber(m?.retweet_count) + readNumber(m?.quote_count),
          ...(m?.impression_count !== undefined ? { views: readNumber(m.impression_count) } : {}),
          live: true,
        };
      }
      // Deleted posts come back under `errors` rather than `data`.
      for (const id of ids) if (!seen.has(id)) out[id] = { live: false };
    }
    return out;
  },

  async remove(externalId, secrets) {
    const res = await signed(secrets, 'DELETE', `/2/tweets/${encodeURIComponent(externalId)}`);
    if (!res.ok) throw httpFailure(res, LABEL, 'delete');
  },
};
