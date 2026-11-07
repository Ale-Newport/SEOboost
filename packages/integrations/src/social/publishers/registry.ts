import type { PublishInput, PublisherInfo, SocialAccountSecrets, SocialPlatformValue, SocialPublisher } from '../types';
import { bareSubreddit } from '../urls';
import { blueskyPublisher } from './bluesky';
import { devtoPublisher } from './devto';
import { discordPublisher } from './discord';
import { linkedinPublisher } from './linkedin';
import { mastodonPublisher } from './mastodon';
import { redditPublisher } from './reddit';
import { telegramPublisher } from './telegram';
import { xPublisher } from './x';

/**
 * Which platforms the product can write to, and how a human posts where it cannot.
 *
 * Platforms without a write API (Hacker News) or that are listening-only here (YouTube, GitHub,
 * Facebook, Instagram, V2EX) are never automated: an approved post becomes `MANUAL_PENDING` with
 * a prefilled link, and the operator posts it themselves. There is no browser-automation
 * fallback, by design.
 */

const PUBLISHERS: readonly SocialPublisher[] = [
  redditPublisher,
  blueskyPublisher,
  mastodonPublisher,
  xPublisher,
  linkedinPublisher,
  devtoPublisher,
  telegramPublisher,
  discordPublisher,
];

const BY_PLATFORM = new Map<SocialPlatformValue, SocialPublisher>(PUBLISHERS.map((publisher) => [publisher.platform, publisher]));

export const MANUAL_ONLY_PLATFORMS: readonly SocialPlatformValue[] = [
  'HACKER_NEWS',
  'YOUTUBE',
  'GITHUB',
  'FACEBOOK',
  'INSTAGRAM',
  'V2EX',
];

export function getPublisher(platform: SocialPlatformValue): SocialPublisher | null {
  return BY_PLATFORM.get(platform) ?? null;
}

/**
 * Whether a connected account can write, not just read. A Reddit app connected without the
 * owner's login is deliberately read-only (search and community rules), so it never gets posts
 * planned for it.
 */
export function canPublishWith(platform: SocialPlatformValue, secrets: SocialAccountSecrets): boolean {
  if (!getPublisher(platform)) return false;
  if (platform === 'REDDIT') {
    const viaOAuth = secrets.credentials.authType === 'oauth2' && Boolean(secrets.credentials.accessToken || secrets.credentials.refreshToken);
    return viaOAuth || Boolean(secrets.credentials.username?.trim() && secrets.credentials.password);
  }
  return true;
}

function toInfo(publisher: SocialPublisher): PublisherInfo {
  return {
    platform: publisher.platform,
    label: publisher.label,
    setupHelp: publisher.setupHelp,
    credentialFields: publisher.credentialFields,
    configFields: publisher.configFields,
    capabilities: publisher.capabilities,
  };
}

/** Every publisher, functions stripped — safe to send to the browser. */
export function listPublishers(): PublisherInfo[] {
  return PUBLISHERS.map(toInfo);
}

export function publisherInfo(platform: SocialPlatformValue): PublisherInfo | null {
  const publisher = getPublisher(platform);
  return publisher ? toInfo(publisher) : null;
}

function withParams(base: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * A prefilled link a human can open to post by hand, or null when there is nothing sensible.
 *
 * Replies always go to the thread itself: no platform offers a "prefilled reply" URL, and the
 * person should read the thread again before answering anyway.
 */
export function manualPostUrl(platform: SocialPlatformValue, input: PublishInput): string | null {
  if (input.kind === 'REPLY') return input.replyTo?.url ?? null;
  const textWithLink = input.linkUrl && !input.body.includes(input.linkUrl) ? `${input.body}\n\n${input.linkUrl}` : input.body;

  switch (platform) {
    case 'HACKER_NEWS':
      return input.linkUrl
        ? withParams('https://news.ycombinator.com/submitlink', { u: input.linkUrl, t: input.title })
        : 'https://news.ycombinator.com/submit';
    case 'REDDIT': {
      if (!input.community) return null;
      return withParams(`https://www.reddit.com/r/${encodeURIComponent(bareSubreddit(input.community))}/submit`, {
        title: input.title,
        ...(input.body.trim() ? { text: input.body } : { url: input.linkUrl }),
      });
    }
    case 'X':
      return withParams('https://x.com/intent/post', { text: textWithLink });
    case 'LINKEDIN':
      return input.linkUrl ? withParams('https://www.linkedin.com/sharing/share-offsite/', { url: input.linkUrl }) : null;
    case 'BLUESKY':
      return withParams('https://bsky.app/intent/compose', { text: textWithLink });
    default:
      return null;
  }
}
