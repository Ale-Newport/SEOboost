import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetcher } from '../fetcher';

// These tests stub the network through global fetch; send the connection-time SSRF guard's
// fetch there too (the guard itself is covered in packages/shared/src/__tests__/ssrf-rebinding.test.ts).
vi.mock('@seo/shared/ssrf', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seo/shared/ssrf')>()),
  guardedFetch: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

/**
 * The crawler fetches whatever URL a user typed as their site — and wherever that site
 * redirects — from inside the deployment, so the SSRF guard must hold on every hop.
 * IP-literal URLs keep these tests off real DNS.
 */

const PUBLIC = 'http://93.184.216.34';

function stubFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Fetcher SSRF guard', () => {
  it('refuses a private target without sending a request or retrying', async () => {
    const calls = stubFetch(() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));
    const fetcher = createFetcher({ allowPrivateNetwork: false, retries: 3 });

    const result = await fetcher.fetchPage('http://169.254.169.254/latest/meta-data/');

    expect(calls).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.error).toMatch(/Refused to fetch/);
  });

  it('refuses a redirect from a public page into the private network', async () => {
    const calls = stubFetch((url) =>
      url.startsWith(PUBLIC)
        ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.7:6379/' } })
        : new Response('secret', { headers: { 'content-type': 'text/html' } }),
    );
    const fetcher = createFetcher({ allowPrivateNetwork: false, retries: 1 });

    const result = await fetcher.fetchPage(`${PUBLIC}/`);

    expect(calls).toEqual([`${PUBLIC}/`]);
    expect(result.body).toBeNull();
    expect(result.error).toMatch(/10\.0\.0\.7/);
  });

  it('fetches public targets normally', async () => {
    stubFetch(() => new Response('<html><title>ok</title></html>', { headers: { 'content-type': 'text/html' } }));
    const fetcher = createFetcher({ allowPrivateNetwork: false, retries: 1 });

    const result = await fetcher.fetchPage(`${PUBLIC}/`);

    expect(result.ok).toBe(true);
    expect(result.body).toContain('ok');
  });

  it('can be opened up for local development', async () => {
    stubFetch(() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));
    const fetcher = createFetcher({ allowPrivateNetwork: true, retries: 1 });

    const result = await fetcher.fetchPage('http://127.0.0.1:8080/');

    expect(result.ok).toBe(true);
  });
});
