import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Agent } from 'undici';
import { BlockedUrlError, assertPublicUrl, createGuardedAgent, createGuardedLookup, guardedFetch } from '../ssrf';

/**
 * DNS rebinding: a hostile resolver answers "public" when the URL is checked and "private" when
 * the socket connects. `guardedFetch` checks the addresses inside the connection's own lookup,
 * so the address that is checked is the address that is connected to. A stub resolver maps
 * `rebind.test` onto a local server, so nothing here touches real DNS or the internet.
 */

const PUBLIC = '93.184.216.34';

let server: Server;
let port: number;
let hits = 0;
const agents: Agent[] = [];

function agent(options: Parameters<typeof createGuardedAgent>[0]): Agent {
  const created = createGuardedAgent(options);
  agents.push(created);
  return created;
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('internal secret');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  hits = 0;
  await Promise.all(agents.splice(0).map((created) => created.close()));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('guardedFetch (connection-time SSRF guard)', () => {
  it('blocks a hostname that resolves to loopback', async () => {
    const dispatcher = agent({ allowPrivateNetwork: false, resolve: async () => [{ address: '127.0.0.1' }] });

    await expect(
      guardedFetch(`http://rebind.test:${port}/`, { redirect: 'manual' }, { allowPrivateNetwork: false, dispatcher }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(hits).toBe(0);
  });

  it('connects when the private network is allowed', async () => {
    const dispatcher = agent({ allowPrivateNetwork: true, resolve: async () => [{ address: '127.0.0.1' }] });

    const response = await guardedFetch(
      `http://rebind.test:${port}/`,
      { redirect: 'manual' },
      { allowPrivateNetwork: true, dispatcher },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('internal secret');
    expect(hits).toBe(1);
  });

  it('blocks a rebinding answer: public for the check, loopback for the connection', async () => {
    let calls = 0;
    const resolve = async () => [{ address: calls++ === 0 ? PUBLIC : '127.0.0.1' }];
    const url = `http://rebind.test:${port}/`;

    // The pre-flight check sees the public answer and passes...
    await expect(assertPublicUrl(url, { allowPrivateNetwork: false, lookup: resolve })).resolves.toBeUndefined();
    // ...but the connection resolves again and is refused before any byte reaches the server.
    const dispatcher = agent({ allowPrivateNetwork: false, resolve });
    await expect(guardedFetch(url, { redirect: 'manual' }, { allowPrivateNetwork: false, dispatcher })).rejects.toThrow(
      /127\.0\.0\.1/,
    );
    expect(calls).toBe(2);
    expect(hits).toBe(0);
  });

  it('blocks when any resolved address is private', async () => {
    const dispatcher = agent({
      allowPrivateNetwork: false,
      resolve: async () => [{ address: PUBLIC }, { address: '127.0.0.1' }],
    });

    await expect(
      guardedFetch(`http://rebind.test:${port}/`, { redirect: 'manual' }, { allowPrivateNetwork: false, dispatcher }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(hits).toBe(0);
  });

  it('refuses private IP literals and internal hostnames without a lookup', async () => {
    for (const url of [`http://127.0.0.1:${port}/`, 'http://[::1]/', 'http://169.254.169.254/', `http://localhost:${port}/`]) {
      await expect(guardedFetch(url, { redirect: 'manual' }, { allowPrivateNetwork: false })).rejects.toBeInstanceOf(
        BlockedUrlError,
      );
    }
    expect(hits).toBe(0);
  });

  it('reaches a private IP literal when the private network is allowed', async () => {
    const response = await guardedFetch(`http://127.0.0.1:${port}/`, {}, { allowPrivateNetwork: true });
    expect(response.status).toBe(200);
    await response.text();
  });

  it('refuses to follow redirects on its own while guarding', async () => {
    await expect(guardedFetch(`http://${PUBLIC}/`, {}, { allowPrivateNetwork: false })).rejects.toThrow(/redirect/);
  });
});

describe('createGuardedLookup', () => {
  const lookupAsync = (lookup: ReturnType<typeof createGuardedLookup>, host: string, all: boolean) =>
    new Promise<unknown>((resolve, reject) => {
      lookup(host, { all }, (err, address, family) => (err ? reject(err) : resolve(all ? address : { address, family })));
    });

  it('returns every address with its family for all: true', async () => {
    const lookup = createGuardedLookup({
      allowPrivateNetwork: false,
      resolve: async () => [{ address: PUBLIC }, { address: '2606:4700::6810:84e5' }],
    });
    await expect(lookupAsync(lookup, 'example.test', true)).resolves.toEqual([
      { address: PUBLIC, family: 4 },
      { address: '2606:4700::6810:84e5', family: 6 },
    ]);
  });

  it('returns the first address for a single lookup', async () => {
    const lookup = createGuardedLookup({ allowPrivateNetwork: false, resolve: async () => [{ address: PUBLIC }] });
    await expect(lookupAsync(lookup, 'example.test', false)).resolves.toEqual({ address: PUBLIC, family: 4 });
  });

  it('rejects private answers in both modes', async () => {
    const lookup = createGuardedLookup({ allowPrivateNetwork: false, resolve: async () => [{ address: '10.0.0.7' }] });
    await expect(lookupAsync(lookup, 'example.test', true)).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(lookupAsync(lookup, 'example.test', false)).rejects.toThrow(/10\.0\.0\.7/);
  });
});
