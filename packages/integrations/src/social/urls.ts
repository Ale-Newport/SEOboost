import type { SocialPlatformValue } from './types';

/**
 * Stable thread identity from a URL.
 *
 * The same Reddit thread arrives from agent-reach, the OAuth API and the public JSON with three
 * different URL shapes (`old.`/`www.`, with or without the slug, `redd.it` short links). Keying
 * conversations on the platform's own id is what stops one thread becoming three inbox rows.
 */
export function externalIdFromUrl(platform: SocialPlatformValue, url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim();
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  switch (platform) {
    case 'REDDIT': {
      const comments = path.match(/\/comments\/([a-z0-9]+)/i);
      if (comments?.[1]) return `t3_${comments[1].toLowerCase()}`;
      if (host === 'redd.it') {
        const id = path.replace(/^\//, '').split('/')[0];
        if (id) return `t3_${id.toLowerCase()}`;
      }
      break;
    }
    case 'HACKER_NEWS': {
      const id = parsed.searchParams.get('id');
      if (id) return id;
      break;
    }
    case 'X': {
      const status = path.match(/\/status(?:es)?\/(\d+)/);
      if (status?.[1]) return status[1];
      break;
    }
    case 'YOUTUBE': {
      const v = parsed.searchParams.get('v');
      if (v) return v;
      if (host === 'youtu.be') return path.replace(/^\//, '');
      const shorts = path.match(/\/shorts\/([\w-]+)/);
      if (shorts?.[1]) return shorts[1];
      break;
    }
    case 'BLUESKY': {
      const post = path.match(/\/profile\/([^/]+)\/post\/([^/]+)/);
      if (post?.[1] && post[2]) return `at://${post[1]}/app.bsky.feed.post/${post[2]}`;
      break;
    }
    default:
      break;
  }
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(key);
  }
  return `${parsed.hostname.replace(/^(www|old|m)\./, '')}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
}

/** `r/name` from any Reddit thread URL, or null. */
export function redditCommunityFromUrl(url: string): string | null {
  const match = url.match(/reddit\.com\/r\/([A-Za-z0-9_]+)/i);
  return match?.[1] ? `r/${match[1]}` : null;
}

/** Normalise a subreddit as typed by a person: `r/Foo`, `/r/Foo/`, `foo` → `Foo` (case kept). */
export function bareSubreddit(name: string): string {
  return name.trim().replace(/^\/?r\//i, '').replace(/\/$/, '');
}
