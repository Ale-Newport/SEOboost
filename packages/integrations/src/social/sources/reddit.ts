import { truncate } from '@seo/shared';
import { readArray, readNumber, readOptionalNumber, readRecord, readString } from '../../serp/http';
import { redditApi, redditPublic, type RedditCredentials } from '../reddit-client';
import type { SearchOptions, SocialFinding } from '../types';
import { bareSubreddit } from '../urls';

/**
 * Native Reddit reader: search and community rules over the Data API.
 *
 * Used before agent-reach when the operator connected a Reddit app (an authenticated API is the
 * most reliable and the most polite route), and as the anonymous fallback when neither is
 * available — in which case Reddit may well refuse, and the error says how to fix it.
 */

function findingFromListingChild(child: unknown, backend: string): SocialFinding | null {
  const data = readRecord(readRecord(child)?.data);
  if (!data) return null;
  const id = readString(data.id);
  const permalink = readString(data.permalink);
  if (!id || !permalink) return null;
  const created = readOptionalNumber(data.created_utc);
  const subreddit = readString(data.subreddit);
  return {
    platform: 'REDDIT',
    externalId: readString(data.name) || `t3_${id}`,
    url: `https://www.reddit.com${permalink}`,
    title: readString(data.title) || null,
    body: readString(data.selftext) ? truncate(readString(data.selftext), 4_000) : null,
    author: readString(data.author) || null,
    community: subreddit ? `r/${subreddit}` : null,
    publishedAt: created !== undefined ? new Date(created * 1000) : null,
    score: readOptionalNumber(data.score) ?? null,
    commentCount: readOptionalNumber(data.num_comments) ?? null,
    isLocked: data.locked === true || data.archived === true,
    backend,
  };
}

/**
 * Search Reddit, newest first within the last week.
 *
 * With communities, each subreddit is searched separately (`restrict_sr`) — a combined
 * `subreddit:a OR subreddit:b` query is silently truncated by Reddit's search parser.
 */
export async function redditSearch(
  query: string,
  opts: SearchOptions,
  creds: RedditCredentials | null,
): Promise<SocialFinding[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 15), 50);
  const params = { q: query, sort: 'new', t: 'week', limit, type: 'link' };
  const targets = opts.communities?.length ? opts.communities.map(bareSubreddit) : [null];
  const backend = creds ? 'reddit-api' : 'reddit-public';
  const out: SocialFinding[] = [];

  for (const subreddit of targets) {
    const path = subreddit ? `/r/${encodeURIComponent(subreddit)}/search` : '/search';
    const query = subreddit ? { ...params, restrict_sr: 1 } : params;
    const body = creds
      ? await redditApi(creds, path, { mode: 'app', query })
      : await redditPublic(`${path}.json`, query);
    for (const child of readArray(readRecord(readRecord(body)?.data)?.children)) {
      const finding = findingFromListingChild(child, backend);
      if (finding && (!opts.since || !finding.publishedAt || finding.publishedAt >= opts.since)) out.push(finding);
    }
  }
  return out;
}

export interface RedditCommunityInfo {
  name: string;
  title: string | null;
  subscribers: number | null;
  /** Public description plus every rule, as written by the moderators. */
  rules: Array<{ title: string; description: string }>;
  description: string | null;
  isPrivate: boolean;
}

/** About + rules for one subreddit, so the guardrails can read what its moderators allow. */
export async function redditCommunityInfo(name: string, creds: RedditCredentials | null): Promise<RedditCommunityInfo> {
  const bare = bareSubreddit(name);
  const get = (path: string) =>
    creds ? redditApi(creds, path, { mode: 'app' }) : redditPublic(`${path}.json`, {});
  const [aboutBody, rulesBody] = await Promise.all([
    get(`/r/${encodeURIComponent(bare)}/about`),
    get(`/r/${encodeURIComponent(bare)}/about/rules`),
  ]);
  const about = readRecord(readRecord(aboutBody)?.data);
  const rules = readArray(readRecord(rulesBody)?.rules).flatMap((rule) => {
    const record = readRecord(rule);
    const title = readString(record?.short_name);
    return title ? [{ title, description: truncate(readString(record?.description), 1_500) }] : [];
  });
  return {
    name: `r/${readString(about?.display_name) || bare}`,
    title: readString(about?.title) || null,
    subscribers: about ? readNumber(about.subscribers, 0) : null,
    rules,
    description: readString(about?.public_description) || readString(about?.description).slice(0, 3_000) || null,
    isPrivate: readString(about?.subreddit_type) === 'private',
  };
}
