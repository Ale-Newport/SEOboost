/**
 * robots.txt loading and evaluation.
 *
 * Policy: an unreachable or malformed robots.txt means "crawl everything". Being blocked by
 * our own inability to read a file would silently produce an empty audit, which is a far
 * worse failure for the site owner than one extra request.
 */

import { createLogger, errorMessage } from '@seo/shared';
import robotsParser from 'robots-parser';
import { createFetcher, type Fetcher } from './fetcher';
import type { RobotsInfo } from './types';

const log = createLogger('crawler:robots');

export interface LoadRobotsOptions {
  fetcher?: Fetcher;
  signal?: AbortSignal;
}

function originOf(input: string): string {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`;
  return new URL(withScheme).origin;
}

function allowAll(origin: string, url: string, overrides: Partial<RobotsInfo> = {}): RobotsInfo {
  return {
    origin,
    url,
    found: false,
    statusCode: null,
    body: null,
    crawlDelay: null,
    sitemaps: [],
    error: null,
    isAllowed: () => true,
    ...overrides,
  };
}

/**
 * Fetch and parse `<origin>/robots.txt` for one user-agent.
 *
 * `isAllowed` closes over the parsed rules so callers do not have to keep passing the
 * user-agent around; `undefined` from the parser (URL on another host, unparseable) is
 * treated as allowed.
 */
export async function loadRobots(
  origin: string,
  userAgent: string,
  options: LoadRobotsOptions = {},
): Promise<RobotsInfo> {
  let base: string;
  try {
    base = originOf(origin);
  } catch {
    return allowAll(origin, origin, { error: `Invalid origin: ${origin}` });
  }

  const robotsUrl = `${base}/robots.txt`;
  const fetcher = options.fetcher ?? createFetcher({ userAgent });

  const result = await fetcher.fetchPage(robotsUrl, { signal: options.signal, acceptText: true });

  if (result.error !== null || result.statusCode === null) {
    log.debug('robots.txt unreachable, allowing all', { robotsUrl, error: result.error });
    return allowAll(base, robotsUrl, { statusCode: result.statusCode, error: result.error });
  }

  if (result.statusCode >= 400 || !result.body) {
    return allowAll(base, robotsUrl, { statusCode: result.statusCode });
  }

  // Soft 404s serve an HTML page with a 200. Parsing that as robots.txt yields nonsense rules.
  const body = result.body;
  if (/^\s*<(?:!doctype|html)\b/i.test(body)) {
    log.debug('robots.txt served HTML, treating as missing', { robotsUrl });
    return allowAll(base, robotsUrl, { statusCode: result.statusCode });
  }

  try {
    const rules = robotsParser(robotsUrl, body);
    const crawlDelay = rules.getCrawlDelay(userAgent);
    return {
      origin: base,
      url: robotsUrl,
      found: body.trim().length > 0,
      statusCode: result.statusCode,
      body,
      crawlDelay: typeof crawlDelay === 'number' && Number.isFinite(crawlDelay) ? crawlDelay : null,
      sitemaps: rules.getSitemaps().filter((s) => typeof s === 'string' && s.trim().length > 0),
      error: null,
      isAllowed: (url: string) => rules.isAllowed(url, userAgent) !== false,
    };
  } catch (err) {
    log.warn('robots.txt parse failed, allowing all', { robotsUrl, error: errorMessage(err) });
    return allowAll(base, robotsUrl, {
      statusCode: result.statusCode,
      body,
      error: errorMessage(err),
    });
  }
}

/** Standalone evaluation for callers that already have the file contents (tests, re-analysis). */
export function evaluateRobots(robotsUrl: string, body: string, userAgent: string): RobotsInfo {
  const base = originOf(robotsUrl);
  try {
    const rules = robotsParser(robotsUrl, body);
    const crawlDelay = rules.getCrawlDelay(userAgent);
    return {
      origin: base,
      url: robotsUrl,
      found: body.trim().length > 0,
      statusCode: 200,
      body,
      crawlDelay: typeof crawlDelay === 'number' && Number.isFinite(crawlDelay) ? crawlDelay : null,
      sitemaps: rules.getSitemaps(),
      error: null,
      isAllowed: (url: string) => rules.isAllowed(url, userAgent) !== false,
    };
  } catch (err) {
    return allowAll(base, robotsUrl, { body, error: errorMessage(err) });
  }
}
