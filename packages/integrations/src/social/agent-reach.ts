import { execFile } from 'node:child_process';
import { createLogger, env, errorMessage, truncate } from '@seo/shared';
import { z } from 'zod';
import { readDate, readOptionalNumber, readRecord } from '../serp/http';
import { SocialSourceError, type SocialFinding, type SocialPlatformValue, type SocialSourceErrorCode } from './types';
import { externalIdFromUrl, redditCommunityFromUrl } from './urls';

/**
 * agent-reach adapter.
 *
 * agent-reach (https://github.com/Panniantong/agent-reach) is a Python CLI that gives an agent
 * read access to platforms it cannot reach on its own — Reddit search, X, YouTube, GitHub,
 * Instagram, Facebook, V2EX… — and prints exactly one JSON envelope per call:
 * `{ schema_version, ok, channel, action, backend, items, meta, error }`.
 *
 * It is used here strictly within its own red lines: read only, never logs in for the user, never
 * retried in a loop on RATE_LIMITED / PLATFORM_BLOCKED / NEED_LOGIN. Logins are the operator's
 * job (`agent-reach login <channel>` in their own terminal); this module only reports that one is
 * needed. Publishing never goes through it — that is what the official APIs in `publishers/` are
 * for.
 *
 * The CLI is optional. When it is not installed every call throws `NOT_CONFIGURED` with the
 * install hint, and listening falls back to the native readers.
 */

const log = createLogger('social:agent-reach');

/** Our platform → agent-reach channel name, for platforms its `search` action covers. */
export const AGENT_REACH_CHANNELS: Partial<Record<SocialPlatformValue, string>> = {
  REDDIT: 'reddit',
  X: 'twitter',
  YOUTUBE: 'youtube',
  GITHUB: 'github',
  FACEBOOK: 'facebook',
  INSTAGRAM: 'instagram',
  V2EX: 'v2ex',
};

export const AGENT_REACH_INSTALL_HINT =
  'Install agent-reach (https://github.com/Panniantong/agent-reach — use the install.md from GitHub, NOT the unrelated PyPI package), ' +
  'then `agent-reach add <channel>` for login channels such as reddit or twitter. Set AGENT_REACH_BIN if the binary is not on PATH.';

const itemSchema = z
  .object({
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    published_at: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    raw: z.unknown().optional(),
  })
  .passthrough();

const envelopeSchema = z
  .object({
    schema_version: z.number().optional(),
    ok: z.boolean(),
    channel: z.string().nullable().optional(),
    action: z.string().nullable().optional(),
    backend: z.string().nullable().optional(),
    items: z.array(itemSchema).default([]),
    meta: z.record(z.unknown()).optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string().optional(),
        hint: z.string().optional(),
        retry_after_seconds: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type AgentReachEnvelope = z.infer<typeof envelopeSchema>;
export type AgentReachItem = z.infer<typeof itemSchema>;

const CODE_MAP: Record<string, SocialSourceErrorCode> = {
  NEED_SETUP: 'NOT_CONFIGURED',
  NEED_LOGIN: 'NEED_LOGIN',
  UPSTREAM_BROKEN: 'UPSTREAM',
  TIMEOUT: 'TIMEOUT',
  RATE_LIMITED: 'RATE_LIMITED',
  PLATFORM_BLOCKED: 'BLOCKED',
  BUSY: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  BAD_INPUT: 'BAD_INPUT',
};

function isAllowedChannel(channel: string): boolean {
  const allow = env.agentReachChannels;
  return allow.length === 0 || allow.includes(channel);
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** Spawn the CLI with an argument vector — never a shell — so a query can never become a command. */
function run(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      env.agentReachBin,
      [...args],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true, ...(signal ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new SocialSourceError('NOT_CONFIGURED', `agent-reach was not found at "${env.agentReachBin}".`, AGENT_REACH_INSTALL_HINT));
          return;
        }
        if (error && 'killed' in error && error.killed) {
          reject(new SocialSourceError('TIMEOUT', `agent-reach did not answer within ${Math.round(timeoutMs / 1000)}s.`));
          return;
        }
        // A non-zero exit still prints the JSON envelope with the error code — parse it rather
        // than treating the exit status as the whole story.
        const exitCode = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : error ? 1 : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode });
      },
    );
  });
}

/** Parse the envelope from stdout. Upstream tools sometimes print a banner first, so take the last JSON object. */
export function parseEnvelope(stdout: string): AgentReachEnvelope {
  const trimmed = stdout.trim();
  const start = trimmed.startsWith('{') ? 0 : trimmed.lastIndexOf('\n{') + 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start));
  } catch {
    throw new SocialSourceError('UPSTREAM', `agent-reach printed something that is not its JSON envelope: ${truncate(trimmed, 200)}`);
  }
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new SocialSourceError('UPSTREAM', `agent-reach envelope did not match the expected shape (schema_version 1).`);
  }
  return result.data;
}

/** Run one agent-reach command and return its items, or throw the typed error it reported. */
export async function agentReachCall(
  args: readonly string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ items: AgentReachItem[]; backend: string | null }> {
  const timeoutMs = opts.timeoutMs ?? env.agentReachTimeoutMs;
  const startedAt = Date.now();
  const result = await run(args, timeoutMs, opts.signal);
  if (!result.stdout.trim()) {
    throw new SocialSourceError(
      'UPSTREAM',
      `agent-reach exited with code ${result.exitCode} and no output${result.stderr ? `: ${truncate(result.stderr.trim(), 300)}` : ''}.`,
    );
  }
  const envelope = parseEnvelope(result.stdout);
  log.debug('agent-reach call', { args: args.slice(0, 2), ok: envelope.ok, items: envelope.items.length, ms: Date.now() - startedAt });
  if (!envelope.ok) {
    const code = CODE_MAP[envelope.error?.code ?? ''] ?? 'UPSTREAM';
    throw new SocialSourceError(
      code,
      envelope.error?.message || envelope.error?.code || 'agent-reach reported a failure',
      envelope.error?.hint ?? null,
      envelope.error?.retry_after_seconds ?? null,
    );
  }
  return { items: envelope.items, backend: envelope.backend ?? null };
}

export interface AgentReachStatus {
  available: boolean;
  version: string | null;
  bin: string;
  message: string;
}

let statusCache: { at: number; value: AgentReachStatus } | null = null;
const STATUS_TTL_MS = 5 * 60_000;

/**
 * Is the CLI installed? Cached for five minutes: the answer changes when the operator installs
 * it, not between two jobs, and spawning Python on every page render would be wasteful.
 */
export async function agentReachStatus(force = false): Promise<AgentReachStatus> {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
  let value: AgentReachStatus;
  try {
    // `agent-reach version` prints the management envelope: { ok, action, result: { version } }.
    const result = await run(['version'], 15_000);
    let version: string | null = null;
    try {
      const parsed = readRecord(JSON.parse(result.stdout.trim()) as unknown);
      const inner = readRecord(parsed?.result);
      version = typeof inner?.version === 'string' ? inner.version : null;
    } catch {
      version = null;
    }
    value = result.exitCode === 0
      ? { available: true, version, bin: env.agentReachBin, message: version ? `agent-reach ${version} is installed.` : 'agent-reach is installed.' }
      : { available: false, version: null, bin: env.agentReachBin, message: `agent-reach is installed but \`agent-reach version\` failed (exit ${result.exitCode}).` };
  } catch (err) {
    value = {
      available: false,
      version: null,
      bin: env.agentReachBin,
      message: err instanceof SocialSourceError && err.code === 'NOT_CONFIGURED' ? `${err.message} ${AGENT_REACH_INSTALL_HINT}` : errorMessage(err),
    };
  }
  statusCache = { at: Date.now(), value };
  return value;
}

/** Test seam. */
export function resetAgentReachStatusCache(): void {
  statusCache = null;
}

function numberFrom(raw: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!raw) return null;
  for (const key of keys) {
    const value = readOptionalNumber(raw[key]);
    if (value !== undefined) return value;
  }
  return null;
}

/** Map one agent-reach item onto a finding. Items without a URL cannot be linked to and are dropped. */
export function findingFromAgentReachItem(platform: SocialPlatformValue, item: AgentReachItem, backend: string): SocialFinding | null {
  const url = item.url?.trim();
  if (!url) return null;
  const raw = readRecord(item.raw);
  const post = readRecord(raw?.post) ?? raw;
  const community = platform === 'REDDIT'
    ? redditCommunityFromUrl(url) ?? (typeof post?.subreddit === 'string' ? `r/${post.subreddit}` : null)
    : null;
  return {
    platform,
    externalId: externalIdFromUrl(platform, url),
    url,
    title: item.title?.trim() || null,
    body: item.text ? truncate(item.text.trim(), 4_000) : null,
    author: item.author?.trim() || null,
    community,
    publishedAt: readDate(item.published_at) ?? null,
    score: numberFrom(post, 'score', 'ups', 'likes', 'like_count', 'favorite_count', 'stars'),
    commentCount: numberFrom(post, 'num_comments', 'comments', 'comment_count', 'reply_count', 'replies'),
    isLocked: post?.locked === true || post?.archived === true,
    backend: `agent-reach${backend ? `:${backend}` : ''}`,
  };
}

/** `agent-reach <channel> search "<query>" --limit N`, normalised into findings. */
export async function agentReachSearch(
  platform: SocialPlatformValue,
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<SocialFinding[]> {
  const channel = AGENT_REACH_CHANNELS[platform];
  if (!channel) throw new SocialSourceError('UNSUPPORTED', `agent-reach has no search channel for ${platform}.`);
  if (!isAllowedChannel(channel)) {
    throw new SocialSourceError('NOT_CONFIGURED', `agent-reach channel "${channel}" is not in AGENT_REACH_CHANNELS.`);
  }
  const limit = Math.min(Math.max(1, opts.limit ?? 10), 25);
  const { items, backend } = await agentReachCall([channel, 'search', query, '--limit', String(limit)], opts);
  return items
    .map((item) => findingFromAgentReachItem(platform, item, backend ?? channel))
    .filter((finding): finding is SocialFinding => finding !== null);
}

/** `agent-reach read <url>` — full text plus top comments, used before drafting a reply. */
export async function agentReachRead(url: string, opts: { signal?: AbortSignal } = {}): Promise<string | null> {
  const { items } = await agentReachCall(['read', url], opts);
  const text = items.map((item) => item.text ?? '').join('\n\n').trim();
  return text ? truncate(text, 12_000) : null;
}
