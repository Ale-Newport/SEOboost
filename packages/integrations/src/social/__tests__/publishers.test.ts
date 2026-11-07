import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetRedditTokens } from '../reddit-client';
import { SocialSourceError, type PublishInput } from '../types';
import { buildLinkFacets, toAtUri } from '../publishers/bluesky';
import { devtoTags } from '../publishers/devto';
import { parseRedditJsonResponse, redditPublisher } from '../publishers/reddit';
import { getPublisher, listPublishers, manualPostUrl, MANUAL_ONLY_PLATFORMS } from '../publishers/registry';
import { assertWithinLimit, publishLength } from '../publishers/shared';
import { oauth1Header } from '../publishers/x';

const original = (over: Partial<PublishInput> = {}): PublishInput => ({
  kind: 'ORIGINAL',
  title: 'A useful guide',
  body: 'We wrote up how we plan meals.',
  linkUrl: 'https://mealwise.app/guide?utm_source=x',
  community: null,
  replyTo: null,
  canonicalUrl: null,
  tags: [],
  ...over,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetRedditTokens();
});

describe('oauth1Header', () => {
  it('reproduces the published Twitter signing example', () => {
    const header = oauth1Header({
      method: 'POST',
      url: 'https://api.twitter.com/1.1/statuses/update.json?include_entities=true',
      consumerKey: 'xvz1evFS4wEEPTGEFPHBog',
      consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
      token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb',
      tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
      nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg',
      timestamp: 1318622958,
      extraParams: { status: 'Hello Ladies + Gentlemen, a signed OAuth request!' },
    });
    const signature = decodeURIComponent(header.match(/oauth_signature="([^"]+)"/)?.[1] ?? '');
    expect(signature).toBe('hCtSmYh+iHYCEqBWrE7C7hYmtUk=');
    expect(header.startsWith('OAuth ')).toBe(true);
    expect(header).toContain('oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog"');
  });
});

describe('Bluesky facets', () => {
  it('addresses links in UTF-8 bytes, not string indices', () => {
    const facets = buildLinkFacets('café 👍 https://a.co');
    expect(facets).toHaveLength(1);
    // "café " is 6 bytes, "👍" is 4, the space 1 → the URL starts at byte 11 and is 12 bytes long.
    expect(facets[0]!.index).toEqual({ byteStart: 11, byteEnd: 23 });
    expect(facets[0]!.features[0]!.uri).toBe('https://a.co');
  });

  it('keeps sentence punctuation out of the link and finds every URL', () => {
    const facets = buildLinkFacets('See https://a.co/x. And https://b.co');
    expect(facets.map((f) => f.features[0]!.uri)).toEqual(['https://a.co/x', 'https://b.co']);
    expect(facets[0]!.index.byteEnd - facets[0]!.index.byteStart).toBe('https://a.co/x'.length);
  });

  it('converts web links to AT-URIs', () => {
    expect(toAtUri('https://bsky.app/profile/alice.bsky.social/post/3kabc')).toBe('at://alice.bsky.social/app.bsky.feed.post/3kabc');
    expect(toAtUri('at://did:plc:x/app.bsky.feed.post/1')).toBe('at://did:plc:x/app.bsky.feed.post/1');
    expect(toAtUri('https://example.com')).toBeNull();
  });
});

describe('Reddit', () => {
  it('turns json.errors into typed failures even on HTTP 200', () => {
    expect(() =>
      parseRedditJsonResponse({ json: { errors: [['SUBREDDIT_NOEXIST', "that subreddit doesn't exist", 'sr']] } }, 'submit'),
    ).toThrowError(/SUBREDDIT_NOEXIST/);

    let caught: unknown;
    try {
      parseRedditJsonResponse({ json: { errors: [['RATELIMIT', 'you are doing that too much. try again in 9 minutes.', 'ratelimit']] } }, 'submit');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SocialSourceError);
    expect((caught as SocialSourceError).code).toBe('RATE_LIMITED');
    expect((caught as SocialSourceError).retryAfterSeconds).toBe(540);

    expect(parseRedditJsonResponse({ json: { errors: [], data: { name: 't3_abc' } } }, 'submit').data.name).toBe('t3_abc');
  });

  it('submits a self post with the right form and returns the fullname', async () => {
    const calls: Array<{ url: string; body: string | null }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : null });
      if (url.includes('/api/v1/access_token')) return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      return jsonResponse({ json: { errors: [], data: { name: 't3_new', url: 'https://www.reddit.com/r/test/comments/new/x/' } } });
    });
    const result = await redditPublisher.publish(original({ community: 'r/test' }), {
      credentials: { clientId: 'id', clientSecret: 'secret', username: 'me', password: 'pw' },
      config: {},
    });
    expect(result).toEqual({ externalId: 't3_new', url: 'https://www.reddit.com/r/test/comments/new/x/' });
    const submit = new URLSearchParams(calls[1]!.body ?? '');
    expect(calls[1]!.url).toContain('https://oauth.reddit.com/api/submit');
    expect(submit.get('sr')).toBe('test');
    expect(submit.get('kind')).toBe('self');
    expect(submit.get('title')).toBe('A useful guide');
    expect(submit.get('api_type')).toBe('json');
  });

  it('refuses a post with no title before calling the API', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(
      redditPublisher.publish(original({ title: null, community: 'r/test' }), {
        credentials: { clientId: 'id', clientSecret: 'secret', username: 'me', password: 'pw' },
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('limits', () => {
  it('weighs URLs on X and refuses rather than truncates', () => {
    expect(publishLength('X', `hi https://example.com/${'a'.repeat(100)}`)).toBe(3 + 23);
    expect(() => assertWithinLimit('BLUESKY', 'x'.repeat(301))).toThrowError(/allows 300/);
    expect(() => assertWithinLimit('BLUESKY', 'x'.repeat(300))).not.toThrow();
  });

  it('cleans Dev.to tags', () => {
    expect(devtoTags(['Meal Planning', 'node-js', 'Café', 'a', 'b', 'c'])).toEqual(['mealplanning', 'nodejs', 'cafe', 'a']);
  });
});

describe('registry', () => {
  it('has a publisher for every writable platform and none for manual-only ones', () => {
    for (const platform of ['REDDIT', 'BLUESKY', 'MASTODON', 'X', 'LINKEDIN', 'DEVTO', 'TELEGRAM', 'DISCORD'] as const) {
      expect(getPublisher(platform)?.platform).toBe(platform);
    }
    for (const platform of MANUAL_ONLY_PLATFORMS) expect(getPublisher(platform)).toBeNull();
    const info = listPublishers();
    expect(info.every((entry) => !('publish' in entry))).toBe(true);
    // Every secret-looking field is flagged secret so the UI never echoes it.
    for (const entry of info) {
      for (const field of entry.credentialFields) {
        if (/secret|password|token|webhook/i.test(field.key) && field.key !== 'accessToken') expect(field.secret).toBe(true);
      }
    }
  });

  it('builds prefilled manual-posting links', () => {
    const hn = manualPostUrl('HACKER_NEWS', original({ title: 'Show HN: Mealwise' }));
    expect(hn).toContain('https://news.ycombinator.com/submitlink?');
    expect(new URL(hn!).searchParams.get('t')).toBe('Show HN: Mealwise');
    expect(new URL(hn!).searchParams.get('u')).toBe('https://mealwise.app/guide?utm_source=x');

    const reddit = manualPostUrl('REDDIT', original({ community: 'r/SideProject' }));
    expect(reddit).toContain('https://www.reddit.com/r/SideProject/submit?');

    const x = manualPostUrl('X', original());
    expect(new URL(x!).searchParams.get('text')).toContain('https://mealwise.app/guide');

    expect(manualPostUrl('LINKEDIN', original())).toContain('share-offsite');
    expect(manualPostUrl('BLUESKY', original())).toContain('bsky.app/intent/compose');
    expect(
      manualPostUrl('YOUTUBE', original({ kind: 'REPLY', replyTo: { externalId: 'abc', url: 'https://youtube.com/watch?v=abc' } })),
    ).toBe('https://youtube.com/watch?v=abc');
    expect(manualPostUrl('REDDIT', original({ community: null }))).toBeNull();
  });
});
