import { truncate } from '@seo/shared';
import { httpRequest } from '../../adapters/http';
import { readArray, readOptionalNumber, readRecord, readString } from '../../serp/http';
import { SocialSourceError, type SearchOptions, type SocialFinding } from '../types';

/**
 * Hacker News via the Algolia search API — public, free, no key, and the documented way to
 * search HN. Both stories (including Ask HN) and comments are returned, because on HN the
 * "is there a tool for…" question is as often a comment as a post. The URL stored is always the
 * HN discussion, not the story's outbound link: that is where a reply would go.
 */

const ALGOLIA = 'https://hn.algolia.com/api/v1/search_by_date';

function stripHtml(html: string): string {
  return html
    .replace(/<p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim();
}

export async function hackerNewsSearch(query: string, opts: SearchOptions): Promise<SocialFinding[]> {
  const since = opts.since ?? new Date(Date.now() - 7 * 86_400_000);
  const res = await httpRequest(ALGOLIA, {
    query: {
      query,
      tags: '(story,comment)',
      hitsPerPage: Math.min(Math.max(1, opts.limit ?? 20), 50),
      numericFilters: `created_at_i>${Math.floor(since.getTime() / 1000)}`,
    },
  });
  if (res.status === 429) throw new SocialSourceError('RATE_LIMITED', 'Hacker News search is rate limiting requests.', null, 60);
  if (!res.ok) throw new SocialSourceError('UPSTREAM', `Hacker News search failed (HTTP ${res.status}).`);

  return readArray(readRecord(res.body)?.hits).flatMap((hit): SocialFinding[] => {
    const record = readRecord(hit);
    const id = readString(record?.objectID);
    if (!record || !id) return [];
    const tags = readArray(record._tags).map((tag) => String(tag));
    const isComment = tags.includes('comment');
    const created = readOptionalNumber(record.created_at_i);
    const text = isComment ? readString(record.comment_text) : readString(record.story_text);
    return [
      {
        platform: 'HACKER_NEWS',
        externalId: id,
        url: `https://news.ycombinator.com/item?id=${id}`,
        title: (isComment ? readString(record.story_title) : readString(record.title)) || null,
        body: text ? truncate(stripHtml(text), 4_000) : null,
        author: readString(record.author) || null,
        community: tags.includes('ask_hn') ? 'Ask HN' : tags.includes('show_hn') ? 'Show HN' : 'HN',
        publishedAt: created !== undefined ? new Date(created * 1000) : null,
        score: readOptionalNumber(record.points) ?? null,
        commentCount: readOptionalNumber(record.num_comments) ?? null,
        isLocked: false,
        backend: 'hn-algolia',
      },
    ];
  });
}
