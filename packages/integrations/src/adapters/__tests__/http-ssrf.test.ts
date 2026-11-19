import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTransportError, httpRequest } from '../http';

// These tests stub the network through global fetch; send the connection-time SSRF guard's
// fetch there too (the guard itself is covered in packages/shared/src/__tests__/ssrf-rebinding.test.ts).
vi.mock('@seo/shared/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seo/shared/ssrf')>()),
  guardedFetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

/**
 * Webhook, WordPress and self-hosted API URLs are typed by users and called from the server,
 * so `userSuppliedUrl` requests must refuse private targets on the first hop and on redirects.
 * IP-literal URLs keep these tests off real DNS.
 */

const PUBLIC = 'https://93.184.216.34';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('httpRequest with userSuppliedUrl', () => {
  it('refuses a private endpoint before sending anything', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK_FETCH', 'false');
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      httpRequest('http://127.0.0.1:6379/', { method: 'POST', rawBody: '{}', userSuppliedUrl: true }),
    ).rejects.toBeInstanceOf(HttpTransportError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a redirect to cloud metadata', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK_FETCH', 'false');
    const fetchSpy = vi.fn(
      async () => new Response(null, { status: 307, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    await expect(httpRequest(`${PUBLIC}/hook`, { method: 'POST', rawBody: '{}', userSuppliedUrl: true })).rejects.toThrow(
      /169\.254\.169\.254/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('follows a public redirect, rewriting 303 to GET and dropping credentials across origins', async () => {
    vi.stubEnv('ALLOW_PRIVATE_NETWORK_FETCH', 'false');
    const seen: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit) => {
      seen.push({
        url: String(input),
        method: String(init.method),
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body,
      });
      if (seen.length === 1) return new Response(null, { status: 303, headers: { location: 'https://8.8.8.8/done' } });
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    });

    const res = await httpRequest(`${PUBLIC}/hook`, {
      method: 'POST',
      body: { a: 1 },
      headers: { Authorization: 'Bearer secret' },
      userSuppliedUrl: true,
    });

    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ url: 'https://8.8.8.8/done', method: 'GET', body: undefined });
    expect(Object.keys(seen[1]!.headers).map((key) => key.toLowerCase())).not.toContain('authorization');
  });

  it('leaves requests without the flag untouched', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchSpy);

    await httpRequest('http://127.0.0.1:9999/api');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
