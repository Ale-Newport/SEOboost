import { httpRequest } from '../../adapters/http';
import { readArray, readNumber, readRecord, readString } from '../../serp/http';
import { blueskyError, blueskySession, blueskyWebUrl, blueskyXrpc, type BlueskySession } from '../bluesky-client';
import { SocialSourceError, type PostMetrics, type PublishResult, type SocialAccountSecrets, type SocialPublisher } from '../types';
import { assertWithinLimit } from './shared';

/**
 * Bluesky publisher — AT Protocol records written to the account's own repository.
 *
 * Bluesky does not auto-link URLs in post text: a link is only clickable when the record carries
 * a facet spanning it, addressed in UTF-8 *byte* offsets. Getting those offsets wrong (by using
 * JavaScript string indices) produces links that cover the wrong characters as soon as the text
 * contains an accent or an emoji, which is why `buildLinkFacets` is pure and tested on its own.
 */

const LABEL = 'Bluesky';
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

export interface LinkFacet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: 'app.bsky.richtext.facet#link'; uri: string }>;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

/** One link facet per URL in the text, with UTF-8 byte offsets as the protocol requires. */
export function buildLinkFacets(text: string): LinkFacet[] {
  const facets: LinkFacet[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    if (match.index === undefined) continue;
    // A sentence ending in a URL ("see https://a.co.") must not pull the full stop into the link.
    const uri = match[0].replace(TRAILING_PUNCTUATION, '');
    const byteStart = byteLength(text.slice(0, match.index));
    facets.push({
      index: { byteStart, byteEnd: byteStart + byteLength(uri) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri }],
    });
  }
  return facets;
}

interface StrongRef {
  uri: string;
  cid: string;
}

/** `at://…` from an AT-URI or a bsky.app post URL. */
export function toAtUri(value: string): string | null {
  if (value.startsWith('at://')) return value;
  const match = value.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/);
  return match?.[1] && match[2] ? `at://${match[1]}/app.bsky.feed.post/${match[2]}` : null;
}

/** AT-URIs from web links carry a handle; record lookups need the DID. */
async function withDid(session: BlueskySession, atUri: string): Promise<string> {
  const match = atUri.match(/^at:\/\/([^/]+)(\/.*)$/);
  if (!match?.[1] || !match[2] || match[1].startsWith('did:')) return atUri;
  const resolved = readRecord(await blueskyXrpc(session, 'com.atproto.identity.resolveHandle', { query: { handle: match[1] } }));
  const did = readString(resolved?.did);
  if (!did) throw new SocialSourceError('NOT_FOUND', `Could not resolve the Bluesky handle ${match[1]}.`);
  return `at://${did}${match[2]}`;
}

/** `app.bsky.feed.getPosts` with repeated `uris` parameters (the shared query helper takes one value per key). */
async function getPosts(session: BlueskySession, uris: readonly string[]): Promise<Record<string, unknown>[]> {
  const query = uris.map((uri) => `uris=${encodeURIComponent(uri)}`).join('&');
  const res = await httpRequest(`${session.service}/xrpc/app.bsky.feed.getPosts?${query}`, {
    headers: { authorization: `Bearer ${session.accessJwt}` },
  });
  if (!res.ok) throw blueskyError(res, 'app.bsky.feed.getPosts');
  return readArray(readRecord(res.body)?.posts).flatMap((post) => {
    const record = readRecord(post);
    return record ? [record] : [];
  });
}

async function replyRefs(session: BlueskySession, target: string): Promise<{ root: StrongRef; parent: StrongRef }> {
  const atUri = toAtUri(target);
  if (!atUri) throw new SocialSourceError('BAD_INPUT', `"${target}" is not a Bluesky post.`);
  const uri = await withDid(session, atUri);
  const [post] = await getPosts(session, [uri]);
  const parent: StrongRef = { uri: readString(post?.uri), cid: readString(post?.cid) };
  if (!post || !parent.uri || !parent.cid) throw new SocialSourceError('NOT_FOUND', 'The Bluesky post being replied to no longer exists.');
  // Replying to a reply keeps the thread's original root, or the reply lands in a new thread.
  const root = readRecord(readRecord(readRecord(post.record)?.reply)?.root);
  const rootRef: StrongRef = root && readString(root.uri) && readString(root.cid)
    ? { uri: readString(root.uri), cid: readString(root.cid) }
    : parent;
  return { root: rootRef, parent };
}

function rkeyOf(atUri: string): string {
  const rkey = atUri.split('/').pop();
  if (!rkey) throw new SocialSourceError('BAD_INPUT', `"${atUri}" is not a Bluesky record URI.`);
  return rkey;
}

async function session(secrets: SocialAccountSecrets): Promise<BlueskySession> {
  return blueskySession(secrets.credentials, secrets.config);
}

export const blueskyPublisher: SocialPublisher = {
  platform: 'BLUESKY',
  label: LABEL,
  setupHelp:
    'Create an app password in Bluesky (Settings → Privacy and security → App passwords). Never use the account password.',
  credentialFields: [
    { key: 'identifier', label: 'Handle', required: true, secret: false, placeholder: 'yourname.bsky.social' },
    { key: 'appPassword', label: 'App password', required: true, secret: true, placeholder: 'xxxx-xxxx-xxxx-xxxx' },
  ],
  configFields: [
    {
      key: 'service',
      label: 'PDS URL',
      required: false,
      secret: false,
      placeholder: 'https://bsky.social',
      help: 'Only for self-hosted or third-party PDS accounts.',
    },
  ],
  capabilities: { original: true, reply: true, title: false, metrics: true, remove: true },

  async test(secrets) {
    const s = await session(secrets);
    return { ok: true, handle: `@${s.handle}`, displayName: s.handle, message: `Connected as @${s.handle}.` };
  },

  async publish(input, secrets): Promise<PublishResult> {
    assertWithinLimit('BLUESKY', input.body);
    const s = await session(secrets);
    const facets = buildLinkFacets(input.body);
    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text: input.body,
      createdAt: new Date().toISOString(),
      ...(facets.length ? { facets } : {}),
    };
    if (input.kind === 'REPLY') {
      if (!input.replyTo) throw new SocialSourceError('BAD_INPUT', 'A Bluesky reply needs the post being answered.');
      record.reply = await replyRefs(s, input.replyTo.externalId || input.replyTo.url);
    } else if (input.linkUrl) {
      record.embed = {
        $type: 'app.bsky.embed.external',
        external: { uri: input.linkUrl, title: input.title?.trim() || input.linkUrl, description: '' },
      };
    }
    const created = readRecord(
      await blueskyXrpc(s, 'com.atproto.repo.createRecord', {
        method: 'POST',
        body: { repo: s.did, collection: 'app.bsky.feed.post', record },
      }),
    );
    const uri = readString(created?.uri);
    if (!uri) throw new SocialSourceError('UPSTREAM', 'Bluesky accepted the post but returned no record URI.');
    return { externalId: uri, url: blueskyWebUrl(uri, s.handle) };
  },

  async metrics(externalIds, secrets) {
    const s = await session(secrets);
    const out: Record<string, PostMetrics> = {};
    // getPosts accepts at most 25 URIs per call.
    for (let i = 0; i < externalIds.length; i += 25) {
      const batch = externalIds.slice(i, i + 25);
      const posts = await getPosts(s, batch);
      const seen = new Set<string>();
      for (const post of posts) {
        const uri = readString(post.uri);
        if (!uri) continue;
        seen.add(uri);
        out[uri] = {
          likes: readNumber(post.likeCount),
          comments: readNumber(post.replyCount),
          reposts: readNumber(post.repostCount) + readNumber(post.quoteCount),
          live: true,
        };
      }
      // A URI the app view no longer returns has been deleted.
      for (const uri of batch) if (!seen.has(uri)) out[uri] = { live: false };
    }
    return out;
  },

  async remove(externalId, secrets) {
    const s = await session(secrets);
    await blueskyXrpc(s, 'com.atproto.repo.deleteRecord', {
      method: 'POST',
      body: { repo: s.did, collection: 'app.bsky.feed.post', rkey: rkeyOf(externalId) },
    });
  },
};
