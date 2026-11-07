import { httpRequest } from '../../adapters/http';
import { readRecord, readString } from '../../serp/http';
import { SocialSourceError, type PublishResult, type SocialAccountSecrets, type SocialPublisher } from '../types';
import { assertWithinLimit, configString, httpFailure, requireCredential } from './shared';

/**
 * LinkedIn publisher — the versioned Posts API (`/rest/posts`).
 *
 * Original posts only: the API offers comments solely on content the member or organisation
 * already owns, so there is no "reply in a thread" here. The new post's URN is returned in the
 * `x-restli-id` header rather than the body, which is easy to miss.
 */

const LABEL = 'LinkedIn';
const DEFAULT_API_VERSION = '202410';

function headers(secrets: SocialAccountSecrets): Record<string, string> {
  return {
    authorization: `Bearer ${requireCredential(secrets, 'accessToken', LABEL)}`,
    'linkedin-version': configString(secrets, 'apiVersion') ?? DEFAULT_API_VERSION,
    'x-restli-protocol-version': '2.0.0',
  };
}

function author(secrets: SocialAccountSecrets): string {
  const urn = configString(secrets, 'authorUrn');
  if (!urn || !/^urn:li:(person|organization):/.test(urn)) {
    throw new SocialSourceError('NOT_CONFIGURED', 'LinkedIn needs the author URN (urn:li:person:… or urn:li:organization:…).');
  }
  return urn;
}

export const linkedinPublisher: SocialPublisher = {
  platform: 'LINKEDIN',
  label: LABEL,
  setupHelp:
    'Create an app at developer.linkedin.com with "Share on LinkedIn" (w_member_social) or the Community Management API (w_organization_social), generate an access token, and enter the person or organisation URN to post as. Tokens expire after ~60 days.',
  credentialFields: [{ key: 'accessToken', label: 'Access token', required: true, secret: true }],
  configFields: [
    { key: 'authorUrn', label: 'Author URN', required: true, secret: false, placeholder: 'urn:li:person:AbC123 or urn:li:organization:12345' },
    { key: 'apiVersion', label: 'API version', required: false, secret: false, placeholder: DEFAULT_API_VERSION, help: 'YYYYMM; LinkedIn retires versions after a year.' },
  ],
  capabilities: { original: true, reply: false, title: false, metrics: false, remove: false },

  async test(secrets) {
    const urn = author(secrets);
    const res = await httpRequest('https://api.linkedin.com/v2/userinfo', {
      headers: { authorization: `Bearer ${requireCredential(secrets, 'accessToken', LABEL)}` },
    });
    if (res.status === 401) throw httpFailure(res, LABEL, 'credential check');
    if (!res.ok) {
      // The userinfo endpoint needs the `openid` scope, which a posting-only token may lack; the
      // token can still be valid for posting, but this check cannot prove it.
      return {
        ok: true,
        handle: urn,
        displayName: null,
        message: `Token accepted, but it has no OpenID scope, so the account could not be confirmed (HTTP ${res.status}). The first post will be the real test.`,
      };
    }
    const info = readRecord(res.body);
    const name = readString(info?.name) || null;
    return { ok: true, handle: urn, displayName: name, message: name ? `Connected as ${name}; posting as ${urn}.` : `Token valid; posting as ${urn}.` };
  },

  async publish(input, secrets): Promise<PublishResult> {
    if (input.kind === 'REPLY') throw new SocialSourceError('UNSUPPORTED', 'LinkedIn\'s API cannot reply in other people\'s threads.');
    assertWithinLimit('LINKEDIN', input.body);
    const body: Record<string, unknown> = {
      author: author(secrets),
      commentary: input.body,
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
      ...(input.linkUrl
        ? { content: { article: { source: input.linkUrl, title: input.title?.trim() || input.linkUrl } } }
        : {}),
    };
    const res = await httpRequest('https://api.linkedin.com/rest/posts', { method: 'POST', body, headers: headers(secrets) });
    if (!res.ok) throw httpFailure(res, LABEL, 'post');
    const urn = res.headers.get('x-restli-id') ?? readString(readRecord(res.body)?.id);
    if (!urn) throw new SocialSourceError('UPSTREAM', 'LinkedIn accepted the post but returned no URN.');
    return { externalId: urn, url: `https://www.linkedin.com/feed/update/${urn}` };
  },
};
