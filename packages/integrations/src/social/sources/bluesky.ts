import { truncate } from '@seo/shared';
import { httpRequest } from '../../adapters/http';
import { readArray, readDate, readOptionalNumber, readRecord, readString } from '../../serp/http';
import { BSKY_PUBLIC_APPVIEW, blueskyError, blueskySession, blueskyWebUrl, blueskyXrpc } from '../bluesky-client';
import type { SearchOptions, SocialAccountSecrets, SocialFinding } from '../types';

/**
 * Bluesky post search.
 *
 * With a connected account the search runs authenticated (the public AppView has started
 * refusing anonymous search); without one it tries the public AppView and reports a typed
 * NEED_LOGIN if that is refused, so the operator knows connecting an account fixes it.
 */
export async function blueskySearch(
  query: string,
  opts: SearchOptions,
  account: SocialAccountSecrets | null,
): Promise<SocialFinding[]> {
  const params = {
    q: query,
    sort: 'latest',
    limit: Math.min(Math.max(1, opts.limit ?? 25), 100),
    ...(opts.since ? { since: opts.since.toISOString() } : {}),
  };

  let body: unknown;
  let backend = 'bluesky-public';
  if (account) {
    const session = await blueskySession(account.credentials, account.config);
    body = await blueskyXrpc(session, 'app.bsky.feed.searchPosts', { query: params });
    backend = 'bluesky-api';
  } else {
    const res = await httpRequest(`${BSKY_PUBLIC_APPVIEW}/xrpc/app.bsky.feed.searchPosts`, { query: params });
    if (!res.ok) throw blueskyError(res, 'search');
    body = res.body;
  }

  return readArray(readRecord(body)?.posts).flatMap((entry): SocialFinding[] => {
    const post = readRecord(entry);
    const uri = readString(post?.uri);
    const author = readRecord(post?.author);
    const record = readRecord(post?.record);
    if (!post || !uri) return [];
    const handle = readString(author?.handle);
    const text = readString(record?.text);
    return [
      {
        platform: 'BLUESKY',
        externalId: uri,
        url: blueskyWebUrl(uri, handle) ?? uri,
        title: null,
        body: text ? truncate(text, 4_000) : null,
        author: handle || null,
        community: null,
        publishedAt: readDate(record?.createdAt) ?? readDate(post.indexedAt) ?? null,
        score: readOptionalNumber(post.likeCount) ?? null,
        commentCount: readOptionalNumber(post.replyCount) ?? null,
        isLocked: false,
        backend,
      },
    ];
  });
}
