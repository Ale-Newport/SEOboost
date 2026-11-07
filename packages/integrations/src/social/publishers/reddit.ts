import { readArray, readNumber, readOptionalNumber, readRecord, readString } from '../../serp/http';
import { readRedditCredentials, redditApi, type RedditCredentials } from '../reddit-client';
import { SocialSourceError, type PostMetrics, type PublishResult, type SocialAccountSecrets, type SocialPublisher } from '../types';
import { bareSubreddit } from '../urls';
import { assertWithinLimit, configString } from './shared';

/**
 * Reddit publisher — the official Data API with a "script" app owned by the posting account.
 *
 * Reddit reports most write failures inside a 200 response (`json.errors`), not as HTTP statuses,
 * so every write goes through `parseRedditJsonResponse`; a missed error there would record a post
 * as published that never existed.
 */

const LABEL = 'Reddit';

function credentials(secrets: SocialAccountSecrets): RedditCredentials {
  const creds = readRedditCredentials(secrets.credentials);
  if (!creds) throw new SocialSourceError('NOT_CONFIGURED', 'Reddit needs the script app\'s client id and secret.');
  return creds;
}

export interface RedditJsonResult {
  data: Record<string, unknown>;
}

/**
 * Unwrap Reddit's `{ json: { errors, data } }` envelope.
 *
 * Each error is a `[CODE, message, field]` triple. RATELIMIT is a rate limit even though it
 * arrives with HTTP 200; everything else is a problem with the submission itself.
 */
export function parseRedditJsonResponse(body: unknown, operation: string): RedditJsonResult {
  const json = readRecord(readRecord(body)?.json);
  if (!json) throw new SocialSourceError('UPSTREAM', `Reddit ${operation} returned an unexpected response.`);
  const errors = readArray(json.errors).map((entry) => readArray(entry).map((part) => readString(part)));
  if (errors.length > 0) {
    const message = errors.map((parts) => parts.filter(Boolean).slice(0, 2).join(': ')).join('; ');
    if (errors.some((parts) => parts[0] === 'RATELIMIT')) {
      const minutes = message.match(/(\d+)\s*minute/);
      const seconds = message.match(/(\d+)\s*second/);
      const retry = minutes?.[1] ? Number(minutes[1]) * 60 : seconds?.[1] ? Number(seconds[1]) : 600;
      throw new SocialSourceError('RATE_LIMITED', `Reddit ${operation}: ${message}`, null, retry);
    }
    throw new SocialSourceError('BAD_INPUT', `Reddit ${operation} was refused: ${message}`);
  }
  return { data: readRecord(json.data) ?? {} };
}

function permalinkUrl(permalink: string): string | null {
  if (!permalink) return null;
  return permalink.startsWith('http') ? permalink : `https://www.reddit.com${permalink}`;
}

export const redditPublisher: SocialPublisher = {
  platform: 'REDDIT',
  label: LABEL,
  setupHelp:
    'Create a "script" app at https://www.reddit.com/prefs/apps while logged in as the posting account; the id is under the app name, the secret is labelled "secret". The id and secret alone enable reliable searching and community rules; add the username and password only if this account should post.',
  credentialFields: [
    { key: 'clientId', label: 'App client id', required: true, secret: false, placeholder: 'e.g. a1B2c3D4e5F6g7' },
    { key: 'clientSecret', label: 'App secret', required: true, secret: true },
    {
      key: 'username',
      label: 'Reddit username',
      required: false,
      secret: false,
      placeholder: 'without u/',
      help: 'Only needed to post. Leave empty to use Reddit for listening only.',
    },
    {
      key: 'password',
      label: 'Reddit password',
      required: false,
      secret: true,
      help: 'Only needed to post. Script apps authenticate as their owner. With two-factor authentication on, enter "password:123456" using a fresh code — or use an account without 2FA.',
    },
  ],
  configFields: [
    {
      key: 'ownedCommunities',
      label: 'Communities you own or moderate',
      required: false,
      secret: false,
      placeholder: 'r/YourProduct, u_yourname',
      help: 'Comma-separated. Posts here count as your own channel; posts anywhere else always need approval.',
    },
    {
      key: 'defaultCommunity',
      label: 'Default community for original posts',
      required: false,
      secret: false,
      placeholder: 'u_yourname (your profile)',
    },
  ],
  capabilities: { original: true, reply: true, title: true, metrics: true, remove: true },

  async test(secrets) {
    const creds = credentials(secrets);
    if (!creds.username || !creds.password) {
      // App-only: proves the id/secret work for search and rules without claiming posting rights.
      await redditApi(creds, '/r/announcements/about', { mode: 'app' });
      return {
        ok: true,
        handle: null,
        displayName: null,
        message: 'Connected for listening (app-only). Add the account username and password to let it post.',
      };
    }
    const me = readRecord(await redditApi(creds, '/api/v1/me', { mode: 'user' }));
    const name = readString(me?.name);
    if (!name) return { ok: false, handle: null, displayName: null, message: 'Reddit accepted the credentials but returned no account.' };
    return { ok: true, handle: `u/${name}`, displayName: name, message: `Connected as u/${name}.` };
  },

  async publish(input, secrets): Promise<PublishResult> {
    const creds = credentials(secrets);
    assertWithinLimit('REDDIT', input.body);

    if (input.kind === 'REPLY') {
      const thingId = input.replyTo?.externalId;
      if (!thingId || !/^t[13]_/.test(thingId)) {
        throw new SocialSourceError('BAD_INPUT', 'A Reddit reply needs the thread\'s fullname (t3_…) or a comment\'s (t1_…).');
      }
      const { data } = parseRedditJsonResponse(
        await redditApi(creds, '/api/comment', { method: 'POST', mode: 'user', form: { thing_id: thingId, text: input.body } }),
        'comment',
      );
      const thing = readRecord(readRecord(readArray(data.things)[0])?.data);
      const name = readString(thing?.name);
      if (!name) throw new SocialSourceError('UPSTREAM', 'Reddit accepted the comment but did not return its id.');
      return { externalId: name, url: permalinkUrl(readString(thing?.permalink)) };
    }

    const community = input.community ?? configString(secrets, 'defaultCommunity');
    if (!community) {
      throw new SocialSourceError('BAD_INPUT', 'Choose a subreddit (or set a default community such as u_yourname) for this post.');
    }
    const title = input.title?.trim();
    if (!title) throw new SocialSourceError('BAD_INPUT', 'Reddit posts need a title.');

    const isLink = !input.body.trim() && Boolean(input.linkUrl);
    const form: Record<string, string> = {
      sr: bareSubreddit(community),
      title,
      kind: isLink ? 'link' : 'self',
      resubmit: 'true',
      sendreplies: 'true',
      ...(isLink ? { url: input.linkUrl ?? '' } : { text: input.body }),
    };
    const { data } = parseRedditJsonResponse(
      await redditApi(creds, '/api/submit', { method: 'POST', mode: 'user', form }),
      'submit',
    );
    const name = readString(data.name);
    if (!name) throw new SocialSourceError('UPSTREAM', 'Reddit accepted the post but did not return its id.');
    return { externalId: name, url: readString(data.url) || null };
  },

  async metrics(externalIds, secrets) {
    const creds = credentials(secrets);
    const out: Record<string, PostMetrics> = {};
    // /api/info takes up to 100 fullnames per call.
    for (let i = 0; i < externalIds.length; i += 100) {
      const ids = externalIds.slice(i, i + 100);
      const listing = readRecord(await redditApi(creds, '/api/info', { mode: 'app', query: { id: ids.join(',') } }));
      for (const child of readArray(readRecord(listing?.data)?.children)) {
        const data = readRecord(readRecord(child)?.data);
        const name = readString(data?.name);
        if (!data || !name) continue;
        const removed = Boolean(data.removed_by_category) || readString(data.author) === '[deleted]' || readString(data.body) === '[removed]';
        const comments = readOptionalNumber(data.num_comments);
        out[name] = {
          score: readNumber(data.score),
          ...(comments !== undefined ? { comments } : {}),
          live: !removed,
        };
      }
    }
    return out;
  },

  async remove(externalId, secrets) {
    await redditApi(credentials(secrets), '/api/del', { method: 'POST', mode: 'user', form: { id: externalId } });
  },
};
