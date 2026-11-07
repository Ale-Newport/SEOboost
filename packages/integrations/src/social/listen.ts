import { createLogger, errorMessage } from '@seo/shared';
import { AGENT_REACH_CHANNELS, agentReachSearch, agentReachStatus } from './agent-reach';
import { readRedditCredentials } from './reddit-client';
import { blueskySearch } from './sources/bluesky';
import { hackerNewsSearch } from './sources/hackernews';
import { redditSearch } from './sources/reddit';
import {
  SocialSourceError,
  type SearchOptions,
  type SocialAccountSecrets,
  type SocialFinding,
  type SocialPlatformValue,
} from './types';
import { bareSubreddit } from './urls';

/**
 * One entry point for "find conversations about X on platform Y".
 *
 * Every platform has an ordered list of readers, in the same spirit as agent-reach's own
 * primary-plus-fallbacks design: the most reliable route first, then the next. A *final* error
 * (rate limit, platform verification wall, bad input) stops the chain instead of falling
 * through — asking the same platform again by another door is exactly what gets an account
 * flagged.
 */

const log = createLogger('social:listen');

/** Platforms listening can search, in the order the UI offers them. */
export const LISTENING_PLATFORMS: readonly SocialPlatformValue[] = [
  'REDDIT',
  'HACKER_NEWS',
  'BLUESKY',
  'X',
  'YOUTUBE',
  'GITHUB',
  'V2EX',
  'FACEBOOK',
  'INSTAGRAM',
];

/** Platforms that can only be read through agent-reach. */
export function needsAgentReach(platform: SocialPlatformValue): boolean {
  return platform !== 'REDDIT' && platform !== 'HACKER_NEWS' && platform !== 'BLUESKY' && platform in AGENT_REACH_CHANNELS;
}

export interface ListenRequest extends SearchOptions {
  platform: SocialPlatformValue;
  query: string;
  /** Connected accounts, by platform. Only their read scopes are used here. */
  accounts?: Partial<Record<SocialPlatformValue, SocialAccountSecrets>>;
}

export interface ListenAttempt {
  backend: string;
  ok: boolean;
  count: number;
  error: { code: string; message: string; hint: string | null } | null;
}

export interface ListenResult {
  findings: SocialFinding[];
  backend: string | null;
  attempts: ListenAttempt[];
  /** The last error when every reader failed; null on success (even with zero findings). */
  error: SocialSourceError | null;
}

type Reader = { name: string; run: () => Promise<SocialFinding[]> };

async function readersFor(req: ListenRequest): Promise<Reader[]> {
  const opts: SearchOptions = {
    ...(req.limit !== undefined ? { limit: req.limit } : {}),
    ...(req.communities ? { communities: req.communities } : {}),
    ...(req.since !== undefined ? { since: req.since } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  };
  const agentReach = AGENT_REACH_CHANNELS[req.platform] ? await agentReachStatus() : null;
  const viaAgentReach: Reader | null = agentReach?.available
    ? {
        name: 'agent-reach',
        run: async () => {
          // agent-reach's Reddit search has no subreddit parameter; Reddit's own search syntax does.
          const queries = req.platform === 'REDDIT' && req.communities?.length
            ? req.communities.map((name) => `${req.query} subreddit:${bareSubreddit(name)}`)
            : [req.query];
          const results: SocialFinding[] = [];
          for (const query of queries) {
            results.push(...(await agentReachSearch(req.platform, query, opts)));
          }
          // agent-reach's public-web route returns the best matches of all time, not the latest;
          // threads older than the window are not conversations anyone is still reading.
          const since = req.since;
          return since ? results.filter((finding) => !finding.publishedAt || finding.publishedAt >= since) : results;
        },
      }
    : null;

  switch (req.platform) {
    case 'REDDIT': {
      const account = req.accounts?.REDDIT;
      const creds = account ? readRedditCredentials(account.credentials) : null;
      return [
        ...(creds ? [{ name: 'reddit-api', run: () => redditSearch(req.query, opts, creds) }] : []),
        ...(viaAgentReach ? [viaAgentReach] : []),
        { name: 'reddit-public', run: () => redditSearch(req.query, opts, null) },
      ];
    }
    case 'HACKER_NEWS':
      return [{ name: 'hn-algolia', run: () => hackerNewsSearch(req.query, opts) }];
    case 'BLUESKY':
      return [{ name: 'bluesky', run: () => blueskySearch(req.query, opts, req.accounts?.BLUESKY ?? null) }];
    default:
      if (!AGENT_REACH_CHANNELS[req.platform]) return [];
      return viaAgentReach ? [viaAgentReach] : [];
  }
}

export async function listen(req: ListenRequest): Promise<ListenResult> {
  const readers = await readersFor(req);
  const attempts: ListenAttempt[] = [];
  if (readers.length === 0) {
    const error = AGENT_REACH_CHANNELS[req.platform]
      ? new SocialSourceError('NOT_CONFIGURED', `${req.platform} can only be read through agent-reach, which is not installed.`, (await agentReachStatus()).message)
      : new SocialSourceError('UNSUPPORTED', `Listening is not available for ${req.platform}.`);
    return { findings: [], backend: null, attempts, error };
  }

  let lastError: SocialSourceError | null = null;
  for (const reader of readers) {
    try {
      const findings = dedupe(await reader.run());
      attempts.push({ backend: reader.name, ok: true, count: findings.length, error: null });
      return { findings, backend: reader.name, attempts, error: null };
    } catch (err) {
      const error = err instanceof SocialSourceError ? err : new SocialSourceError('UPSTREAM', errorMessage(err));
      attempts.push({ backend: reader.name, ok: false, count: 0, error: { code: error.code, message: error.message, hint: error.hint } });
      log.info('listening reader failed', { platform: req.platform, backend: reader.name, code: error.code });
      lastError = error;
      if (error.final) break;
    }
  }
  return { findings: [], backend: null, attempts, error: lastError };
}

function dedupe(findings: SocialFinding[]): SocialFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    if (seen.has(finding.externalId)) return false;
    seen.add(finding.externalId);
    return true;
  });
}
