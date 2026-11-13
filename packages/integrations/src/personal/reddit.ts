import { truncate } from '@seo/shared';
import { readArray, readNumber, readOptionalNumber, readRecord, readString } from '../serp/http';
import { redditApi, type RedditCredentials } from '../social/reddit-client';
import { parseRedditJsonResponse } from '../social/publishers/reddit';
import { SocialSourceError } from '../social/types';
import { bareSubreddit } from '../social/urls';

/**
 * The operator's own Reddit, read and written through the user token from one-click linking.
 *
 * Reads (profile, inbox, own history, a subreddit's listing) are plain API calls. Writes — a
 * reply in the inbox, marking messages read, a post or comment — only happen on a click, and
 * posts/comments into communities go through the social guardrails before they reach `submit`.
 */

export function userCreds(accessToken: string): RedditCredentials {
  return { clientId: '', clientSecret: '', accessToken };
}

export interface RedditIdentity {
  name: string;
  handle: string;
  linkKarma: number;
  commentKarma: number;
  totalKarma: number;
  createdAt: string | null;
  hasMail: boolean;
  inboxCount: number;
  iconUrl: string | null;
}

/** Normalise `GET /api/v1/me`. Exported for tests. */
export function parseRedditIdentity(body: unknown): RedditIdentity {
  const me = readRecord(body);
  const name = readString(me?.name);
  if (!name) throw new SocialSourceError('UPSTREAM', 'Reddit returned no account name for this token.');
  const created = readOptionalNumber(me?.created_utc);
  const link = readNumber(me?.link_karma, 0);
  const comment = readNumber(me?.comment_karma, 0);
  return {
    name,
    handle: `u/${name}`,
    linkKarma: link,
    commentKarma: comment,
    totalKarma: readNumber(me?.total_karma, link + comment),
    createdAt: created !== undefined ? new Date(created * 1000).toISOString() : null,
    hasMail: me?.has_mail === true,
    inboxCount: readNumber(me?.inbox_count, 0),
    iconUrl: readString(me?.icon_img).split('?')[0] || null,
  };
}

export async function fetchRedditIdentity(accessToken: string): Promise<RedditIdentity> {
  return parseRedditIdentity(await redditApi(userCreds(accessToken), '/api/v1/me', { mode: 'user' }));
}

export interface RedditThing {
  /** Fullname: `t1_…` comment, `t3_…` post, `t4_…` message. */
  name: string;
  kind: 'comment' | 'post' | 'message' | 'other';
  author: string | null;
  subreddit: string | null;
  title: string | null;
  body: string | null;
  url: string | null;
  score: number | null;
  comments: number | null;
  createdAt: string | null;
  unread: boolean;
  /** Inbox only: comment reply, username mention, or private message. */
  inboxType: 'comment_reply' | 'post_reply' | 'username_mention' | 'message' | null;
}

const KIND: Record<string, RedditThing['kind']> = { t1: 'comment', t3: 'post', t4: 'message' };

/** Normalise one child of a Reddit listing. Exported for tests. */
export function parseRedditThing(child: unknown): RedditThing | null {
  const record = readRecord(child);
  const data = readRecord(record?.data);
  const name = readString(data?.name);
  if (!data || !name) return null;
  const kind = KIND[readString(record?.kind)] ?? 'other';
  const permalink = readString(data.permalink) || readString(data.context);
  const created = readOptionalNumber(data.created_utc);
  const type = readString(data.type);
  const subject = readString(data.subject);
  return {
    name,
    kind,
    author: readString(data.author) || null,
    subreddit: readString(data.subreddit) ? `r/${readString(data.subreddit)}` : null,
    title: readString(data.title) || readString(data.link_title) || (kind === 'message' ? subject || null : null),
    body: truncate(readString(data.selftext) || readString(data.body), 4_000) || null,
    url: permalink ? `https://www.reddit.com${permalink}` : null,
    score: readOptionalNumber(data.score) ?? null,
    comments: readOptionalNumber(data.num_comments) ?? null,
    createdAt: created !== undefined ? new Date(created * 1000).toISOString() : null,
    unread: data.new === true,
    inboxType:
      type === 'comment_reply' || type === 'post_reply' || type === 'username_mention'
        ? type
        : kind === 'message'
          ? 'message'
          : null,
  };
}

function listing(body: unknown): RedditThing[] {
  return readArray(readRecord(readRecord(body)?.data)?.children)
    .map(parseRedditThing)
    .filter((thing): thing is RedditThing => thing !== null);
}

export async function redditInbox(accessToken: string, where: 'inbox' | 'unread' = 'inbox'): Promise<RedditThing[]> {
  return listing(await redditApi(userCreds(accessToken), `/message/${where}`, { mode: 'user', query: { limit: 50 } }));
}

export async function redditMarkRead(accessToken: string, fullnames: readonly string[]): Promise<void> {
  const ids = fullnames.filter((id) => /^t[134]_[a-z0-9]+$/i.test(id));
  if (ids.length === 0) return;
  await redditApi(userCreds(accessToken), '/api/read_message', { method: 'POST', mode: 'user', form: { id: ids.join(',') } });
}

export async function redditHistory(accessToken: string, username: string): Promise<{ posts: RedditThing[]; comments: RedditThing[] }> {
  const user = encodeURIComponent(username.replace(/^u\//i, ''));
  const creds = userCreds(accessToken);
  const [posts, comments] = await Promise.all([
    redditApi(creds, `/user/${user}/submitted`, { mode: 'user', query: { limit: 25, sort: 'new' } }),
    redditApi(creds, `/user/${user}/comments`, { mode: 'user', query: { limit: 25, sort: 'new' } }),
  ]);
  return { posts: listing(posts), comments: listing(comments) };
}

export async function redditSubscriptions(accessToken: string): Promise<Array<{ name: string; title: string | null; subscribers: number | null }>> {
  const body = await redditApi(userCreds(accessToken), '/subreddits/mine/subscriber', { mode: 'user', query: { limit: 100 } });
  return readArray(readRecord(readRecord(body)?.data)?.children).flatMap((child) => {
    const data = readRecord(readRecord(child)?.data);
    const name = readString(data?.display_name);
    return name ? [{ name: `r/${name}`, title: readString(data?.title) || null, subscribers: readOptionalNumber(data?.subscribers) ?? null }] : [];
  });
}

export async function redditSubredditListing(accessToken: string, subreddit: string, sort: 'hot' | 'new' = 'hot'): Promise<RedditThing[]> {
  const name = bareSubreddit(subreddit);
  if (!/^[A-Za-z0-9_]{2,21}$/.test(name) && !/^u_[A-Za-z0-9_-]{2,30}$/.test(name)) {
    throw new SocialSourceError('BAD_INPUT', `"${subreddit}" is not a subreddit name.`);
  }
  return listing(await redditApi(userCreds(accessToken), `/r/${encodeURIComponent(name)}/${sort}`, { mode: 'user', query: { limit: 25 } }));
}

/** Reply to a comment, post or private message. */
export async function redditReply(accessToken: string, thingId: string, text: string): Promise<{ name: string; url: string | null }> {
  if (!/^t[134]_[a-z0-9]+$/i.test(thingId)) throw new SocialSourceError('BAD_INPUT', 'Not a Reddit comment, post or message id.');
  const body = text.trim();
  if (body.length < 2) throw new SocialSourceError('BAD_INPUT', 'The reply is empty.');
  if (body.length > 10_000) throw new SocialSourceError('BAD_INPUT', 'Reddit replies are limited to 10,000 characters.');
  const { data } = parseRedditJsonResponse(
    await redditApi(userCreds(accessToken), '/api/comment', { method: 'POST', mode: 'user', form: { thing_id: thingId, text: body } }),
    'reply',
  );
  const thing = readRecord(readRecord(readArray(data.things)[0])?.data);
  const permalink = readString(thing?.permalink);
  return { name: readString(thing?.name), url: permalink ? `https://www.reddit.com${permalink}` : null };
}
