import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The AppSetting store is replaced by an in-memory map so the OAuth helpers can be exercised
 * end to end — attempts, developer apps, the Mastodon registration cache — without Postgres.
 */
const store = new Map<string, { value: unknown; updatedAt: Date }>();

vi.mock('@seo/db', () => ({
  getAppSetting: async (key: string, fallback: unknown) => (store.has(key) ? store.get(key)?.value : fallback),
  setAppSetting: async (key: string, value: unknown) => {
    store.set(key, { value, updatedAt: new Date() });
  },
  prisma: {
    appSetting: {
      deleteMany: async ({ where }: { where: { key: string | { startsWith: string }; updatedAt?: { lt: Date } } }) => {
        let count = 0;
        for (const [key, row] of [...store.entries()]) {
          const keyMatches = typeof where.key === 'string' ? key === where.key : key.startsWith(where.key.startsWith);
          const ageMatches = !where.updatedAt || row.updatedAt < where.updatedAt.lt;
          if (keyMatches && ageMatches) {
            store.delete(key);
            count++;
          }
        }
        return { count };
      },
    },
  },
}));

const {
  buildAuthorizeUrl,
  consumeOAuthAttempt,
  createPkce,
  credentialsFromTokens,
  exchangeOAuthCode,
  fetchOAuthIdentity,
  mastodonAppFor,
  mergeRefreshedCredentials,
  normaliseInstanceUrl,
  oauthRedirectUri,
  parseTokenResponse,
  pkceChallenge,
  saveOAuthApp,
  startOAuthAttempt,
  tokenState,
  developerAppStatuses,
} = await import('../oauth');
const { SocialSourceError } = await import('../types');

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  store.clear();
  delete process.env.X_CLIENT_ID;
  delete process.env.X_CLIENT_SECRET;
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
});
afterEach(() => vi.unstubAllGlobals());

describe('authorize URLs and PKCE', () => {
  it('matches the RFC 7636 S256 test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(pkceChallenge(verifier));
  });

  it('builds the X URL with PKCE and the posting scopes', () => {
    const url = new URL(
      buildAuthorizeUrl({ platform: 'X', clientId: 'cid', redirectUri: 'http://localhost:3000/cb', state: 'st', codeChallenge: 'ch' }),
    );
    expect(url.origin + url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('scope')).toBe('tweet.read tweet.write users.read offline.access');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('st');
  });

  it('asks Reddit for a permanent grant and sends no PKCE it does not support', () => {
    const url = new URL(
      buildAuthorizeUrl({ platform: 'REDDIT', clientId: 'cid', redirectUri: 'http://localhost:3000/cb', state: 'st', codeChallenge: 'ignored' }),
    );
    expect(url.searchParams.get('duration')).toBe('permanent');
    expect(url.searchParams.get('code_challenge')).toBeNull();
    expect(url.searchParams.get('scope')).toBe('identity read submit edit history');
  });

  it('builds per-instance Mastodon URLs and one redirect URI per platform', () => {
    expect(normaliseInstanceUrl('@me@Fosstodon.org')).toBe('https://fosstodon.org');
    expect(normaliseInstanceUrl('')).toBe('https://mastodon.social');
    expect(() => normaliseInstanceUrl('http://insecure.example')).toThrow(SocialSourceError);
    const url = buildAuthorizeUrl({
      platform: 'MASTODON', clientId: 'c', redirectUri: 'r', state: 's', codeChallenge: 'x', instanceUrl: 'https://fosstodon.org',
    });
    expect(url.startsWith('https://fosstodon.org/oauth/authorize?')).toBe(true);
    expect(oauthRedirectUri('LINKEDIN', 'https://seo.example/')).toBe('https://seo.example/api/social/oauth/linkedin/callback');
  });
});

describe('attempts', () => {
  it('are single use and carry the PKCE verifier server-side only', async () => {
    process.env.X_CLIENT_ID = 'x-client';
    const started = await startOAuthAttempt({ platform: 'X', websiteId: 'w1', userId: 'u1' });
    const url = new URL(started.url);
    expect(url.searchParams.get('client_id')).toBe('x-client');
    expect(url.searchParams.get('state')).toBe(started.state);
    expect(started.url).not.toContain('verifier');

    const attempt = await consumeOAuthAttempt(started.state);
    expect(attempt).toMatchObject({ platform: 'X', websiteId: 'w1', userId: 'u1' });
    expect(pkceChallenge(attempt?.verifier ?? '')).toBe(url.searchParams.get('code_challenge'));
    expect(await consumeOAuthAttempt(started.state)).toBeNull();
    expect(await consumeOAuthAttempt('not a state')).toBeNull();
  });

  it('refuses to start without a developer app and says where to set it up', async () => {
    const error = await startOAuthAttempt({ platform: 'LINKEDIN', websiteId: 'w', userId: 'u' }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SocialSourceError);
    expect((error as InstanceType<typeof SocialSourceError>).code).toBe('NOT_CONFIGURED');
    expect((error as InstanceType<typeof SocialSourceError>).hint).toMatch(/developer apps/);
  });

  it('lets saved developer apps win over env vars and keeps a stored secret on re-save', async () => {
    process.env.REDDIT_CLIENT_ID = 'from-env';
    process.env.REDDIT_CLIENT_SECRET = 'env-secret';
    let statuses = await developerAppStatuses();
    expect(statuses.find((s) => s.platform === 'REDDIT')).toMatchObject({ configured: true, source: 'env' });
    await saveOAuthApp('REDDIT', { clientId: 'saved-id', clientSecret: 'saved-secret' });
    await saveOAuthApp('REDDIT', { clientId: 'saved-id-2', clientSecret: '' });
    statuses = await developerAppStatuses();
    expect(statuses.find((s) => s.platform === 'REDDIT')).toMatchObject({ source: 'settings', clientIdPreview: 'save…', hasSecret: true });
    await expect(saveOAuthApp('LINKEDIN', { clientId: 'only-id' })).rejects.toThrow(/secret/);
  });
});

describe('Mastodon dynamic registration', () => {
  it('registers once per instance and re-registers when the redirect URI changes', async () => {
    const fetchSpy = vi.fn(async () => json({ client_id: 'mc', client_secret: 'ms' }));
    vi.stubGlobal('fetch', fetchSpy);
    const first = await mastodonAppFor('https://mastodon.social', 'http://localhost:3000/cb');
    const second = await mastodonAppFor('https://mastodon.social', 'http://localhost:3000/cb');
    expect(first).toEqual({ clientId: 'mc', clientSecret: 'ms' });
    expect(second).toEqual(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await mastodonAppFor('https://mastodon.social', 'https://seo.example/cb');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://mastodon.social/api/v1/apps');
    expect(JSON.parse(String(init.body))).toMatchObject({ client_name: 'SEO OS', scopes: 'read write:statuses' });
  });
});

describe('token exchange', () => {
  it('sends the verifier and authenticates a confidential X client with Basic auth', async () => {
    process.env.X_CLIENT_ID = 'xid';
    process.env.X_CLIENT_SECRET = 'xsecret';
    const fetchSpy = vi.fn(async () => json({ access_token: 'at', refresh_token: 'rt', expires_in: 7200, scope: 'tweet.write' }));
    vi.stubGlobal('fetch', fetchSpy);
    const tokens = await exchangeOAuthCode({
      platform: 'X',
      code: 'the-code',
      attempt: { verifier: 'v', instanceUrl: null, redirectUri: 'http://localhost:3000/cb' },
    });
    expect(tokens.accessToken).toBe('at');
    expect(tokens.refreshToken).toBe('rt');
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.x.com/2/oauth2/token');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('xid:xsecret').toString('base64')}`);
    const form = new URLSearchParams(String(init.body));
    expect(form.get('code_verifier')).toBe('v');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('client_secret')).toBeNull();
  });

  it('puts the client id in the body for a public X client', async () => {
    process.env.X_CLIENT_ID = 'public-id';
    const fetchSpy = vi.fn(async () => json({ access_token: 'at', expires_in: 7200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await exchangeOAuthCode({ platform: 'X', code: 'c', attempt: { verifier: 'v', instanceUrl: null, redirectUri: 'r' } });
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(new URLSearchParams(String(init.body)).get('client_id')).toBe('public-id');
  });

  it('treats a refused grant as final (reconnect), even when Reddit reports it with HTTP 200', async () => {
    process.env.REDDIT_CLIENT_ID = 'rid';
    process.env.REDDIT_CLIENT_SECRET = 'rs';
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'invalid_grant' })));
    const error = await exchangeOAuthCode({ platform: 'REDDIT', code: 'c', attempt: { verifier: null, instanceUrl: null, redirectUri: 'r' } }).catch(
      (err: unknown) => err,
    );
    expect((error as InstanceType<typeof SocialSourceError>).code).toBe('NEED_LOGIN');
  });

  it('extracts the Discord webhook the operator picked', () => {
    const tokens = parseTokenResponse('DISCORD', {
      access_token: 'a',
      expires_in: 604800,
      webhook: { url: 'https://discord.com/api/webhooks/1/abc', name: 'SEO OS', channel_id: '42' },
    });
    expect(credentialsFromTokens('DISCORD', tokens)).toEqual({ authType: 'oauth2', webhookUrl: 'https://discord.com/api/webhooks/1/abc' });
    expect(() => credentialsFromTokens('DISCORD', parseTokenResponse('DISCORD', { access_token: 'a' }))).toThrow(/webhook/);
  });

  it('turns LinkedIn userinfo into the author URN posts are made as', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ sub: 'AbC123', name: 'Ada Lovelace' })));
    const identity = await fetchOAuthIdentity(
      'LINKEDIN',
      parseTokenResponse('LINKEDIN', { access_token: 'a', expires_in: 5_184_000 }),
      null,
    );
    expect(identity).toEqual({ handle: 'Ada Lovelace', displayName: 'Ada Lovelace', config: { authorUrn: 'urn:li:person:AbC123' } });
  });
});

describe('token freshness', () => {
  const now = new Date('2026-11-07T12:00:00Z');
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();

  it('decides between use, refresh and reconnect', () => {
    expect(tokenState({ apiKey: 'x' }, now).kind).toBe('not-oauth');
    expect(tokenState({ authType: 'oauth2', accessToken: 'a' }, now).kind).toBe('valid');
    expect(tokenState({ authType: 'oauth2', accessToken: 'a', expiresAt: at(60) }, now).kind).toBe('valid');
    expect(tokenState({ authType: 'oauth2', accessToken: 'a', refreshToken: 'r', expiresAt: at(2) }, now).kind).toBe('refresh');
    expect(tokenState({ authType: 'oauth2', accessToken: 'a', refreshToken: 'r', expiresAt: at(-30) }, now).kind).toBe('refresh');
    // LinkedIn without a refresh token: usable until the moment it expires, then reconnect.
    expect(tokenState({ authType: 'oauth2', accessToken: 'a', expiresAt: at(2) }, now).kind).toBe('valid');
    expect(tokenState({ authType: 'oauth2', accessToken: 'a', expiresAt: at(-1) }, now).kind).toBe('expired');
  });

  it('keeps a refresh token the provider did not rotate', () => {
    const merged = mergeRefreshedCredentials(
      { authType: 'oauth2', accessToken: 'old', refreshToken: 'keep', expiresAt: at(-1) },
      parseTokenResponse('REDDIT', { access_token: 'new', expires_in: 86_400 }, now),
    );
    expect(merged).toMatchObject({ accessToken: 'new', refreshToken: 'keep', expiresAt: at(24 * 60) });
  });
});
