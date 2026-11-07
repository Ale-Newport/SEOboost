import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  agentReachSearch,
  agentReachStatus,
  parseEnvelope,
  resetAgentReachStatusCache,
} from '../agent-reach';
import { listen } from '../listen';
import { SocialSourceError } from '../types';
import { bareSubreddit, externalIdFromUrl, redditCommunityFromUrl } from '../urls';

/**
 * agent-reach is exercised through a stub executable that speaks its JSON envelope, so these
 * tests need neither Python nor network access, and never touch a real platform.
 */
const STUB = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
const out = (value, code = 0) => { process.stdout.write(JSON.stringify(value)); process.exit(code); };
if (args[0] === 'version') out({ schema_version: 1, ok: true, action: 'version', result: { version: '1.6.1' }, error: null });
const query = args[2] || '';
if (query.includes('ratelimit')) {
  out({ schema_version: 1, ok: false, channel: args[0], action: 'search', backend: null, items: [], meta: {},
    error: { code: 'RATE_LIMITED', message: 'slow down', hint: 'wait', retry_after_seconds: 120 } }, 1);
}
if (query.includes('login')) {
  out({ schema_version: 1, ok: false, channel: args[0], action: 'search', backend: null, items: [], meta: {},
    error: { code: 'NEED_LOGIN', message: 'log in', hint: 'agent-reach login reddit' } }, 1);
}
out({ schema_version: 1, ok: true, channel: args[0], action: 'search', backend: 'opencli', meta: {}, error: null, items: [
  { title: 'Any app for meal planning?', url: 'https://www.reddit.com/r/MealPrepSunday/comments/abc123/any_app/', author: 'sam',
    published_at: '2026-11-06T10:00:00Z', text: 'Looking for an app', raw: { score: 12, num_comments: 7, subreddit: 'MealPrepSunday' } },
  { title: 'No url item', url: null, author: null, published_at: null, text: 'dropped', raw: null },
] });
`;

let dir: string;
const previousBin = process.env.AGENT_REACH_BIN;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'agent-reach-stub-'));
  const bin = join(dir, 'agent-reach');
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  process.env.AGENT_REACH_BIN = bin;
});

afterAll(() => {
  if (previousBin === undefined) delete process.env.AGENT_REACH_BIN;
  else process.env.AGENT_REACH_BIN = previousBin;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => resetAgentReachStatusCache());

describe('agent-reach adapter', () => {
  it('reports the installed version', async () => {
    const status = await agentReachStatus(true);
    expect(status.available).toBe(true);
    expect(status.version).toBe('1.6.1');
  });

  it('maps search items onto findings and drops items without a URL', async () => {
    const findings = await agentReachSearch('REDDIT', 'meal planning app', { limit: 5 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      platform: 'REDDIT',
      externalId: 't3_abc123',
      community: 'r/MealPrepSunday',
      score: 12,
      commentCount: 7,
      backend: 'agent-reach:opencli',
    });
    expect(findings[0]?.publishedAt?.toISOString()).toBe('2026-11-06T10:00:00.000Z');
  });

  it('turns envelope errors into typed, final errors', async () => {
    const error = await agentReachSearch('REDDIT', 'ratelimit', {}).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SocialSourceError);
    expect((error as SocialSourceError).code).toBe('RATE_LIMITED');
    expect((error as SocialSourceError).final).toBe(true);
    expect((error as SocialSourceError).retryAfterSeconds).toBe(120);
    const login = await agentReachSearch('X', 'login', {}).catch((err: unknown) => err);
    expect((login as SocialSourceError).code).toBe('NEED_LOGIN');
    expect((login as SocialSourceError).final).toBe(false);
  });

  it('reports a missing binary as NOT_CONFIGURED with the install hint', async () => {
    const saved = process.env.AGENT_REACH_BIN;
    process.env.AGENT_REACH_BIN = join(dir, 'does-not-exist');
    try {
      const status = await agentReachStatus(true);
      expect(status.available).toBe(false);
      expect(status.message).toMatch(/install\.md/);
    } finally {
      process.env.AGENT_REACH_BIN = saved;
    }
  });

  it('parses an envelope printed after a banner', () => {
    const envelope = parseEnvelope('Some banner line\n{"ok":true,"items":[]}');
    expect(envelope.ok).toBe(true);
  });
});

describe('listen()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stops at a final error instead of falling through to another reader', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await listen({ platform: 'REDDIT', query: 'ratelimit' });
    expect(result.error?.code).toBe('RATE_LIMITED');
    expect(result.attempts.map((attempt) => attempt.backend)).toEqual(['agent-reach']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to the public Reddit JSON when agent-reach needs a login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: {
              children: [
                {
                  data: {
                    id: 'zz9', name: 't3_zz9', permalink: '/r/x/comments/zz9/t/', title: 'help', selftext: 'body',
                    author: 'a', subreddit: 'x', created_utc: 1_762_400_000, score: 3, num_comments: 1, locked: false,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const result = await listen({ platform: 'REDDIT', query: 'login' });
    expect(result.attempts.map((attempt) => [attempt.backend, attempt.ok])).toEqual([
      ['agent-reach', false],
      ['reddit-public', true],
    ]);
    expect(result.findings[0]).toMatchObject({ externalId: 't3_zz9', community: 'r/x', backend: 'reddit-public' });
  });

  it('reads Hacker News through Algolia and links to the discussion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('hn.algolia.com');
        return new Response(
          JSON.stringify({
            hits: [
              { objectID: '42', _tags: ['comment'], story_title: 'Ask HN: tools?', comment_text: '<p>Is there a tool &amp; app?', author: 'pg', created_at_i: 1_762_400_000 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const result = await listen({ platform: 'HACKER_NEWS', query: 'tool' });
    expect(result.findings[0]).toMatchObject({
      externalId: '42',
      url: 'https://news.ycombinator.com/item?id=42',
      title: 'Ask HN: tools?',
      body: 'Is there a tool & app?',
    });
  });

  it('says plainly when a platform cannot be listened to', async () => {
    const result = await listen({ platform: 'TELEGRAM', query: 'x' });
    expect(result.error?.code).toBe('UNSUPPORTED');
  });
});

describe('thread identity', () => {
  it('collapses the many shapes of one Reddit thread onto one id', () => {
    expect(externalIdFromUrl('REDDIT', 'https://old.reddit.com/r/a/comments/AbC12/slug/')).toBe('t3_abc12');
    expect(externalIdFromUrl('REDDIT', 'https://redd.it/abc12')).toBe('t3_abc12');
    expect(externalIdFromUrl('X', 'https://x.com/user/status/1234567890')).toBe('1234567890');
    expect(externalIdFromUrl('BLUESKY', 'https://bsky.app/profile/a.bsky.social/post/3k')).toBe('at://a.bsky.social/app.bsky.feed.post/3k');
    expect(externalIdFromUrl('GITHUB', 'https://www.github.com/o/r/issues/1?utm_source=x')).toBe('github.com/o/r/issues/1');
  });

  it('normalises subreddit names', () => {
    expect(redditCommunityFromUrl('https://www.reddit.com/r/SideProject/comments/x')).toBe('r/SideProject');
    expect(bareSubreddit('/r/SideProject/')).toBe('SideProject');
  });
});
