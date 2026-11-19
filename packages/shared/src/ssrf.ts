import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from './env';

/**
 * Server-side request forgery guard for URLs that come from users (crawl targets, CMS and
 * webhook endpoints, self-hosted API bases).
 *
 * The app fetches these from inside the deployment, so without a guard a site URL of
 * `http://169.254.169.254/` or `http://postgres:5432/` turns the crawler into a probe of the
 * private network. The check refuses loopback, private, link-local (cloud metadata), CGNAT,
 * multicast and reserved ranges — for literal IPs and for every address a hostname resolves to.
 *
 * Node-only (DNS); import it as `@seo/shared/ssrf`, never through the isomorphic barrel.
 * `ALLOW_PRIVATE_NETWORK_FETCH=true` turns it off for installs that legitimately crawl a LAN
 * or localhost site.
 *
 * Residual risk, accepted: the address is resolved here and again by `fetch`, so a hostile DNS
 * server that answers differently within the same second (DNS rebinding) can still slip through.
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedUrlError';
  }
}

export type HostLookup = (hostname: string) => Promise<Array<{ address: string }>>;

export interface PublicUrlOptions {
  /** Skip the network checks (default: `ALLOW_PRIVATE_NETWORK_FETCH`). */
  allowPrivateNetwork?: boolean;
  /** Injectable resolver, for tests. */
  lookup?: HostLookup;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function parseIPv4(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) ? octets : null;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  return (
    a === 0 || // "this" network, 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  );
}

/** Expand an IPv6 literal into eight 16-bit groups; null when it is not one. */
function parseIPv6(input: string): number[] | null {
  let address = input.split('%')[0] ?? '';
  // A trailing dotted quad (::ffff:10.0.0.1) becomes two hex groups.
  const dotted = address.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const v4 = parseIPv4(dotted[2]!);
    if (!v4) return null;
    address = `${dotted[1]}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':').map((group) => (/^[0-9a-f]{1,4}$/i.test(group) ? parseInt(group, 16) : NaN));
    return groups.every((group) => Number.isInteger(group)) ? groups : null;
  };
  const head = toGroups(halves[0] ?? '');
  const tail = halves.length === 2 ? toGroups(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function embeddedIPv4(high: number, low: number): number[] {
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

function isPrivateIPv6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstFiveZero && g5 === 0) return true; // ::, ::1 and the deprecated ::a.b.c.d form
  if (firstFiveZero && g5 === 0xffff) return isPrivateIPv4(embeddedIPv4(g6, g7)); // IPv4-mapped
  if (g0 === 0x64 && g1 === 0xff9b) return isPrivateIPv4(embeddedIPv4(g6, g7)); // NAT64
  if (g0 === 0x2002) return isPrivateIPv4(embeddedIPv4(g1, g2)); // 6to4
  if ((g0 & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return true; // site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return true; // discard-only
  return false;
}

/**
 * True when an IP literal points somewhere a server-side fetch must not go: loopback, RFC 1918,
 * link-local (cloud metadata), CGNAT, unique-local, multicast or reserved. Non-IP input is
 * treated as unsafe, so a parsing gap fails closed.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.trim().replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = parseIPv4(bare);
  if (v4) return isPrivateIPv4(v4);
  const v6 = parseIPv6(bare);
  if (v6) return isPrivateIPv6(v6);
  return true;
}

/** Hostnames that name the local machine or a private zone without needing DNS to say so. */
export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.+$/, '');
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

const defaultLookup: HostLookup = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Hosts recently verified as public; keeps the crawler from resolving every URL twice. */
const verifiedHosts = new Map<string, number>();
const VERIFIED_TTL_MS = 30_000;
const VERIFIED_MAX = 1_000;

function blocked(host: string, reason: string): BlockedUrlError {
  return new BlockedUrlError(
    `Refused to fetch ${host}: ${reason}. Server-side requests to private, loopback and cloud-metadata ` +
      'addresses are blocked; set ALLOW_PRIVATE_NETWORK_FETCH=true only if this install must reach a trusted private network.',
  );
}

/**
 * Throw `BlockedUrlError` unless `input` is an http(s) URL whose host is public.
 *
 * A hostname that does not resolve is let through: the request that follows fails with its own,
 * more useful DNS error, and there is no address to protect.
 */
export async function assertPublicUrl(input: string | URL, options: PublicUrlOptions = {}): Promise<void> {
  let url: URL;
  try {
    url = typeof input === 'string' ? new URL(input) : input;
  } catch {
    throw new BlockedUrlError(`Refused to fetch an invalid URL: ${String(input).slice(0, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(`Refused to fetch ${url.protocol} URLs; only http and https are allowed.`);
  }
  if (options.allowPrivateNetwork ?? env.allowPrivateNetworkFetch) return;

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
  if (isBlockedHostname(host)) throw blocked(host, 'it names a local or internal host');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw blocked(host, 'it is a private or reserved address');
    return;
  }

  const cachedUntil = options.lookup ? undefined : verifiedHosts.get(host);
  if (cachedUntil !== undefined && cachedUntil > Date.now()) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await (options.lookup ?? defaultLookup)(host);
  } catch {
    return;
  }
  const internal = addresses.find((entry) => isPrivateAddress(entry.address));
  if (internal) throw blocked(host, `it resolves to the private or reserved address ${internal.address}`);

  if (!options.lookup && addresses.length > 0) {
    if (verifiedHosts.size >= VERIFIED_MAX) verifiedHosts.clear();
    verifiedHosts.set(host, Date.now() + VERIFIED_TTL_MS);
  }
}
