import type { SocialPlatform } from '@seo/db';
import type { AdapterFieldSpec } from '../adapters/types';

/**
 * Social listening and publishing contracts.
 *
 * Two halves with different trust levels. *Reading* public conversations goes through
 * agent-reach (a read-only CLI that never logs in on the user's behalf) or a platform's public
 * API. *Writing* only ever happens through a platform's official API, with an account the
 * operator connected themselves, after the guardrails and the approval queue — never through a
 * browser session, a scraped cookie or an automated login.
 */

export type SocialPlatformValue = SocialPlatform;

/** A public thread or post found while listening, normalised across every reader. */
export interface SocialFinding {
  platform: SocialPlatformValue;
  /** Stable per platform: Reddit `t3_…`, HN item id, Bluesky AT-URI, or the canonical URL. */
  externalId: string;
  url: string;
  title: string | null;
  body: string | null;
  author: string | null;
  /** Subreddit (`r/name`), HN, a Bluesky feed… null on open platforms. */
  community: string | null;
  publishedAt: Date | null;
  score: number | null;
  commentCount: number | null;
  isLocked: boolean;
  /** Which reader produced it. */
  backend: string;
}

export type SocialSourceErrorCode =
  | 'NOT_CONFIGURED'
  | 'NEED_LOGIN'
  | 'RATE_LIMITED'
  | 'BLOCKED'
  | 'UPSTREAM'
  | 'TIMEOUT'
  | 'BAD_INPUT'
  | 'NOT_FOUND'
  | 'UNSUPPORTED';

/**
 * A typed reader/publisher failure.
 *
 * The codes mirror agent-reach's own taxonomy so the operator sees one vocabulary whichever
 * reader failed. `final` codes mean "do not try another backend": a rate limit or a platform
 * verification wall is about the *platform*, and hammering it through a second route is exactly
 * how an account gets flagged.
 */
export class SocialSourceError extends Error {
  constructor(
    readonly code: SocialSourceErrorCode,
    message: string,
    readonly hint: string | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'SocialSourceError';
  }

  get final(): boolean {
    return this.code === 'RATE_LIMITED' || this.code === 'BLOCKED' || this.code === 'BAD_INPUT';
  }
}

export interface SearchOptions {
  limit?: number;
  /** Restrict to these communities (subreddits) where the platform supports it. */
  communities?: readonly string[];
  /** Only return items newer than this. */
  since?: Date | null;
  signal?: AbortSignal;
}

/** Decrypted credentials and plain config for one connected account. */
export interface SocialAccountSecrets {
  credentials: Record<string, string>;
  config: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────
// Publishing
// ─────────────────────────────────────────────────────────────

export interface PublisherCapabilities {
  /** Can create a post on the account's own channel. */
  original: boolean;
  /** Can reply inside an existing thread. */
  reply: boolean;
  /** Takes a separate title (Reddit, Dev.to). */
  title: boolean;
  /** Can read engagement back. */
  metrics: boolean;
  /** Can delete what it published (used for rollback). */
  remove: boolean;
}

export interface PublishInput {
  kind: 'REPLY' | 'ORIGINAL';
  title: string | null;
  body: string;
  linkUrl: string | null;
  /** Target community for platforms that need one (Reddit subreddit). */
  community: string | null;
  /** For replies: the thread being answered, as stored on SocialConversation. */
  replyTo: { externalId: string; url: string } | null;
  /** Long-form canonical URL (Dev.to cross-posts point search engines back at the original). */
  canonicalUrl: string | null;
  tags: readonly string[];
}

export interface PublishResult {
  externalId: string;
  url: string | null;
}

export interface PostMetrics {
  score?: number;
  likes?: number;
  comments?: number;
  reposts?: number;
  views?: number;
  /** False when the platform reports the post deleted or removed by moderators. */
  live?: boolean;
}

export interface ConnectionTest {
  ok: boolean;
  handle: string | null;
  displayName: string | null;
  message: string;
}

export interface SocialPublisher {
  platform: SocialPlatformValue;
  label: string;
  /** One sentence on how to get the credentials, shown on the connect form. */
  setupHelp: string;
  credentialFields: AdapterFieldSpec[];
  configFields: AdapterFieldSpec[];
  capabilities: PublisherCapabilities;
  test(secrets: SocialAccountSecrets): Promise<ConnectionTest>;
  publish(input: PublishInput, secrets: SocialAccountSecrets): Promise<PublishResult>;
  metrics?(externalIds: readonly string[], secrets: SocialAccountSecrets): Promise<Record<string, PostMetrics>>;
  remove?(externalId: string, secrets: SocialAccountSecrets): Promise<void>;
}

/** What the UI may know about a publisher — no functions, safe to serialise. */
export interface PublisherInfo {
  platform: SocialPlatformValue;
  label: string;
  setupHelp: string;
  credentialFields: AdapterFieldSpec[];
  configFields: AdapterFieldSpec[];
  capabilities: PublisherCapabilities;
}
