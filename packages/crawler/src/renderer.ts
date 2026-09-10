/**
 * Optional headless rendering.
 *
 * Playwright is an *optional* dependency and its browser binaries are a separate download, so
 * every entry point here degrades to "not available" instead of throwing. A crawl must never
 * fail because a machine has no Chromium — it just falls back to the static HTML.
 */

import { createLogger, errorMessage } from '@seo/shared';
import { existsSync } from 'node:fs';

const log = createLogger('crawler:renderer');

export const DEFAULT_RENDER_TIMEOUT_MS = 30_000;
export const DEFAULT_NETWORK_IDLE_MS = 5_000;

/**
 * The slice of Playwright's surface we actually use. Declaring it structurally means this
 * module type-checks and builds on machines where `playwright` was never installed.
 */
interface PwRequest {
  resourceType(): string;
}

interface PwRoute {
  request(): PwRequest;
  abort(): Promise<void>;
  continue(): Promise<void>;
}

interface PwResponse {
  status(): number;
  url(): string;
}

interface PwPage {
  route(pattern: string, handler: (route: PwRoute) => void | Promise<void>): Promise<void>;
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<PwResponse | null>;
  waitForLoadState(state: string, options?: { timeout?: number }): Promise<void>;
  content(): Promise<string>;
  url(): string;
  close(): Promise<void>;
}

interface PwContext {
  newPage(): Promise<PwPage>;
  close(): Promise<void>;
}

interface PwBrowser {
  newContext(options?: {
    userAgent?: string;
    viewport?: { width: number; height: number };
    ignoreHTTPSErrors?: boolean;
    locale?: string;
  }): Promise<PwContext>;
  close(): Promise<void>;
  isConnected(): boolean;
}

interface PwBrowserType {
  launch(options?: { headless?: boolean; args?: string[]; timeout?: number }): Promise<PwBrowser>;
  executablePath(): string;
}

interface PwModule {
  chromium: PwBrowserType;
}

/**
 * Imported through a variable so bundlers treat it as an external runtime import rather than
 * trying to resolve (and fail on) an optional dependency at build time.
 */
const PLAYWRIGHT_SPECIFIER = 'playwright';

let modulePromise: Promise<PwModule | null> | null = null;

async function loadPlaywright(): Promise<PwModule | null> {
  if (!modulePromise) {
    modulePromise = (async () => {
      try {
        const imported: unknown = await import(PLAYWRIGHT_SPECIFIER);
        const candidate = imported as { chromium?: PwBrowserType } | null;
        if (!candidate || typeof candidate.chromium?.launch !== 'function') return null;
        return { chromium: candidate.chromium };
      } catch (err) {
        log.debug('playwright is not installed', { error: errorMessage(err) });
        return null;
      }
    })();
  }
  return modulePromise;
}

let availabilityPromise: Promise<boolean> | null = null;

/**
 * True only when both the package and a usable Chromium binary are present. Checks the
 * executable path on disk first — launching a browser just to answer this question would cost
 * seconds on every crawl that has rendering switched off at the site level.
 */
export async function isRenderingAvailable(): Promise<boolean> {
  if (!availabilityPromise) {
    availabilityPromise = (async () => {
      const pw = await loadPlaywright();
      if (!pw) return false;
      try {
        const executable = pw.chromium.executablePath();
        if (executable && existsSync(executable)) return true;
      } catch (err) {
        log.debug('executablePath unavailable, probing with a launch', { error: errorMessage(err) });
      }
      // Path lookup can legitimately fail (custom channel, remote browser); a launch is the
      // only definitive answer left.
      try {
        const browser = await pw.chromium.launch({ headless: true, timeout: 20_000 });
        await browser.close();
        return true;
      } catch (err) {
        log.info('headless rendering unavailable, crawls will use static HTML', {
          error: errorMessage(err),
        });
        return false;
      }
    })();
  }
  return availabilityPromise;
}

export interface RenderOptions {
  /** Overall budget for navigation. */
  timeoutMs?: number;
  /** Extra time allowed for the network to go idle after DOMContentLoaded. */
  networkIdleMs?: number;
  signal?: AbortSignal;
}

export interface RendererOptions {
  userAgent?: string;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  networkIdleMs?: number;
  /**
   * Drop images, media and fonts. They cannot change the DOM we analyse, and skipping them
   * roughly halves render time on media-heavy pages. Default true.
   */
  blockAssets?: boolean;
  locale?: string;
}

export interface RenderResult {
  ok: boolean;
  html: string | null;
  statusCode: number | null;
  finalUrl: string;
  responseTimeMs: number;
  error: string | null;
}

export interface Renderer {
  render(url: string, options?: RenderOptions): Promise<RenderResult>;
  close(): Promise<void>;
}

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font']);

/**
 * A pooled renderer: one browser and one context for the whole crawl, one page per render.
 * The shared context keeps cookies (cookie banners, geo redirects) consistent across the
 * crawl the same way a real session would.
 */
export async function createRenderer(options: RendererOptions = {}): Promise<Renderer | null> {
  const pw = await loadPlaywright();
  if (!pw || !(await isRenderingAvailable())) return null;

  const defaultTimeout = options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
  const defaultIdle = options.networkIdleMs ?? DEFAULT_NETWORK_IDLE_MS;
  const blockAssets = options.blockAssets ?? true;

  let browser: PwBrowser | null = null;
  let context: PwContext | null = null;
  let closed = false;
  let starting: Promise<PwContext> | null = null;

  const ensureContext = async (): Promise<PwContext> => {
    if (context && browser?.isConnected()) return context;
    if (!starting) {
      starting = (async () => {
        browser = await pw.chromium.launch({
          headless: true,
          args: ['--disable-dev-shm-usage', '--no-sandbox'],
          timeout: defaultTimeout,
        });
        context = await browser.newContext({
          userAgent: options.userAgent,
          viewport: options.viewport ?? { width: 1366, height: 900 },
          ignoreHTTPSErrors: true,
          locale: options.locale,
        });
        return context;
      })();
      // Clear the in-flight marker either way. On failure the next render retries the launch
      // instead of awaiting a rejected promise; on success reuse goes back through the
      // `isConnected()` check above, so a browser that later crashes is relaunched rather than
      // handed out dead for the rest of the crawl.
      void starting.then(
        () => {
          starting = null;
        },
        () => {
          starting = null;
        },
      );
    }
    return starting;
  };

  return {
    async render(url: string, renderOptions: RenderOptions = {}): Promise<RenderResult> {
      const startedAt = Date.now();
      const timeoutMs = renderOptions.timeoutMs ?? defaultTimeout;
      const idleMs = renderOptions.networkIdleMs ?? defaultIdle;

      if (closed) {
        return { ok: false, html: null, statusCode: null, finalUrl: url, responseTimeMs: 0, error: 'Renderer closed' };
      }
      if (renderOptions.signal?.aborted) {
        return { ok: false, html: null, statusCode: null, finalUrl: url, responseTimeMs: 0, error: 'Cancelled' };
      }

      let page: PwPage | null = null;
      try {
        const ctx = await ensureContext();
        page = await ctx.newPage();

        if (blockAssets) {
          await page.route('**/*', async (route) => {
            if (BLOCKED_RESOURCE_TYPES.has(route.request().resourceType())) {
              await route.abort().catch(() => undefined);
              return;
            }
            await route.continue().catch(() => undefined);
          });
        }

        // `networkidle` alone hangs forever on pages with polling or long-lived sockets, so
        // navigate on DOMContentLoaded and treat idle as a bounded best-effort extra wait.
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page.waitForLoadState('networkidle', { timeout: idleMs }).catch(() => undefined);

        const html = await page.content();
        return {
          ok: true,
          html,
          statusCode: response ? response.status() : null,
          finalUrl: page.url() || url,
          responseTimeMs: Date.now() - startedAt,
          error: null,
        };
      } catch (err) {
        return {
          ok: false,
          html: null,
          statusCode: null,
          finalUrl: url,
          responseTimeMs: Date.now() - startedAt,
          error: errorMessage(err),
        };
      } finally {
        await page?.close().catch(() => undefined);
      }
    },

    async close(): Promise<void> {
      closed = true;
      const activeContext = context;
      const activeBrowser = browser;
      context = null;
      browser = null;
      starting = null;
      await activeContext?.close().catch(() => undefined);
      await activeBrowser?.close().catch(() => undefined);
    },
  };
}

/** One-shot render. Prefer `createRenderer()` inside a crawl so the browser is reused. */
export async function renderPage(url: string, options: RendererOptions & RenderOptions = {}): Promise<RenderResult> {
  const renderer = await createRenderer(options);
  if (!renderer) {
    return {
      ok: false,
      html: null,
      statusCode: null,
      finalUrl: url,
      responseTimeMs: 0,
      error: 'Headless rendering is not available (playwright or its browsers are not installed)',
    };
  }
  try {
    return await renderer.render(url, options);
  } finally {
    await renderer.close();
  }
}
