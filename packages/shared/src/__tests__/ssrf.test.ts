import { describe, expect, it } from 'vitest';
import { BlockedUrlError, assertPublicUrl, isBlockedHostname, isPrivateAddress } from '../ssrf';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.0.9',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '[::1]',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:0001::1',
    '2001:db8::1',
    'not-an-ip',
  ])('blocks %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8'])(
    'allows public %s',
    (address) => {
      expect(isPrivateAddress(address)).toBe(false);
    },
  );
});

describe('isBlockedHostname', () => {
  it('blocks local and internal names', () => {
    for (const host of ['localhost', 'LOCALHOST.', 'app.localhost', 'printer.local', 'metadata.google.internal', 'x.home.arpa', '']) {
      expect(isBlockedHostname(host)).toBe(true);
    }
  });

  it('allows ordinary public names', () => {
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isBlockedHostname('localhost.example.com')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  const resolvesTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address }));

  it('rejects non-http schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', { allowPrivateNetwork: false })).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertPublicUrl('gopher://example.com/', { allowPrivateNetwork: true })).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it('rejects private IP literals, including the encodings the URL parser normalises', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0x7f.1/',
      'http://[::1]:8080/',
      'http://[::ffff:169.254.169.254]/latest/meta-data',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost:5432/',
    ]) {
      await expect(assertPublicUrl(url, { allowPrivateNetwork: false, lookup: resolvesTo('93.184.216.34') })).rejects.toBeInstanceOf(
        BlockedUrlError,
      );
    }
  });

  it('rejects hostnames that resolve to a private address (any of them)', async () => {
    await expect(
      assertPublicUrl('https://internal.example.com/', { allowPrivateNetwork: false, lookup: resolvesTo('93.184.216.34', '10.0.0.5') }),
    ).rejects.toThrow(/10\.0\.0\.5/);
  });

  it('allows public hosts', async () => {
    await expect(
      assertPublicUrl('https://example.com/page', { allowPrivateNetwork: false, lookup: resolvesTo('93.184.216.34') }),
    ).resolves.toBeUndefined();
    await expect(assertPublicUrl('https://93.184.216.34/', { allowPrivateNetwork: false })).resolves.toBeUndefined();
  });

  it('lets an unresolvable host through so the request reports its own DNS error', async () => {
    const lookup = async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    };
    await expect(assertPublicUrl('https://nope.invalid/', { allowPrivateNetwork: false, lookup })).resolves.toBeUndefined();
  });

  it('is disabled by the private-network override', async () => {
    await expect(assertPublicUrl('http://127.0.0.1:3000/', { allowPrivateNetwork: true })).resolves.toBeUndefined();
  });
});
