'use client';

import { useCallback, useId, useState } from 'react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { apiPatch } from '@/lib/api-client';
import {
  ListField,
  SettingsSection,
  isSame,
  outsideRange,
  useSaveHandler,
} from '@/components/site-settings/settings-form';
import type { CrawlerSettings } from '@/components/site-settings/types';

/**
 * How the crawler behaves on this site.
 *
 * Every field here is a trade-off between how complete the picture is and how much load the site
 * takes, so every field says which way it cuts. These are the numbers that decide whether a crawl
 * finishes in four minutes or four hours — and whether the site's ops team notices.
 */

export interface CrawlerTabProps {
  websiteId: string;
  crawler: CrawlerSettings;
}

/** A number input that keeps its own text so a half-typed value is not clobbered mid-keystroke. */
function NumberField({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  id: string;
  label: string;
  description: React.ReactNode;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}): React.JSX.Element {
  const outOfRange = outsideRange(value, min, max);

  return (
    <FormField
      label={label}
      htmlFor={id}
      description={description}
      {...(outOfRange ? { error: `Must be between ${min} and ${max}.` } : {})}
    >
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step ?? 1}
          value={Number.isFinite(value) ? value : ''}
          onChange={(event) => onChange(Number(event.target.value))}
          className="md:w-40"
        />
        {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
      </div>
    </FormField>
  );
}

export function CrawlerTab({ websiteId, crawler }: CrawlerTabProps): React.JSX.Element {
  const ids = useId();
  const { pending, run } = useSaveHandler();
  const [draft, setDraft] = useState<CrawlerSettings>(crawler);

  const dirty = !isSame(draft, crawler);

  const set = useCallback(<K extends keyof CrawlerSettings>(key: K, value: CrawlerSettings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
  }, []);

  const save = useCallback(() => {
    void run(() => apiPatch(`/api/websites/${websiteId}/settings`, draft), 'Crawler settings saved');
  }, [draft, run, websiteId]);

  const outOfRange =
    outsideRange(draft.crawlMaxPages, 1, 500_000) ||
    outsideRange(draft.crawlMaxDepth, 1, 30) ||
    outsideRange(draft.crawlConcurrency, 1, 16) ||
    outsideRange(draft.crawlDelayMs, 0, 10_000) ||
    outsideRange(draft.crawlTimeoutMs, 1000, 120_000);

  return (
    <SettingsSection
      title="Crawler"
      description="What the crawler is allowed to do to this site. These apply to scheduled crawls and to any crawl you start by hand."
      dirty={dirty}
      pending={pending}
      onSave={save}
      onReset={() => setDraft(crawler)}
      blockedReason={
        outOfRange
          ? 'One or more values are empty or outside the allowed range.'
          : draft.crawlUserAgent.trim().length < 3
            ? 'The user agent must identify your crawler.'
            : null
      }
      footerNote="Changes apply to the next crawl; a crawl already running keeps the settings it started with."
    >
      <div className="grid gap-5 md:grid-cols-2">
        <NumberField
          id={`${ids}-pages`}
          label="Max pages"
          value={draft.crawlMaxPages}
          min={1}
          max={500_000}
          suffix="pages"
          onChange={(value) => set('crawlMaxPages', value)}
          description="Hard stop on how many URLs one crawl fetches. Too low and large sections are simply never seen — pages that were not crawled cannot appear in the audit, the link graph or the orphan report."
        />

        <NumberField
          id={`${ids}-depth`}
          label="Max depth"
          value={draft.crawlMaxDepth}
          min={1}
          max={30}
          suffix="clicks from the homepage"
          onChange={(value) => set('crawlMaxDepth', value)}
          description="How many links from the start URL the crawler will follow. Deep-but-narrow sites need a high number; a shallow marketing site is fully covered at 4 or 5."
        />

        <NumberField
          id={`${ids}-concurrency`}
          label="Concurrency"
          value={draft.crawlConcurrency}
          min={1}
          max={16}
          suffix="parallel requests"
          onChange={(value) => set('crawlConcurrency', value)}
          description="Requests in flight at once. Higher finishes sooner and hits the origin harder; on shared hosting this is the setting that causes 503s and skews the audit with errors that are your fault."
        />

        <NumberField
          id={`${ids}-delay`}
          label="Delay between requests"
          value={draft.crawlDelayMs}
          min={0}
          max={10_000}
          step={50}
          suffix="ms"
          onChange={(value) => set('crawlDelayMs', value)}
          description="Pause after each request. The polite counterweight to concurrency: raise it when the site is rate-limited or fronted by a WAF that treats a fast crawl as an attack."
        />

        <NumberField
          id={`${ids}-timeout`}
          label="Request timeout"
          value={draft.crawlTimeoutMs}
          min={1000}
          max={120_000}
          step={500}
          suffix="ms"
          onChange={(value) => set('crawlTimeoutMs', value)}
          description="How long to wait for one response before giving up. Set too low, genuinely slow pages are recorded as timeouts — which looks like a site problem and is not."
        />
      </div>

      <FormField
        label="User agent"
        htmlFor={`${ids}-agent`}
        description="Sent with every request. Keep it identifiable and contactable: an anonymous agent is the first thing a firewall blocks, and it makes your crawl indistinguishable from a scraper in the site's own logs."
      >
        <Input
          id={`${ids}-agent`}
          value={draft.crawlUserAgent}
          onChange={(event) => set('crawlUserAgent', event.target.value)}
          className="font-mono text-xs"
          spellCheck={false}
          autoComplete="off"
        />
      </FormField>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="min-w-0 space-y-0.5">
            <label htmlFor={`${ids}-robots`} className="block text-sm font-medium text-foreground">
              Respect robots.txt
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              On, the crawler obeys the site&rsquo;s own rules and skips disallowed paths — which
              means those pages are absent from the audit. Turn it off only on a site you control,
              and only when you need to see what search engines are being told to ignore.
            </p>
          </div>
          <Switch
            id={`${ids}-robots`}
            checked={draft.crawlRespectRobots}
            onCheckedChange={(value) => set('crawlRespectRobots', value)}
          />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
          <div className="min-w-0 space-y-0.5">
            <label htmlFor={`${ids}-js`} className="block text-sm font-medium text-foreground">
              Render JavaScript
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Runs each page in a headless browser. Required for a client-rendered app, where the
              raw HTML is an empty shell — but it is roughly an order of magnitude slower and
              heavier per page, so leave it off for server-rendered sites.
            </p>
          </div>
          <Switch
            id={`${ids}-js`}
            checked={draft.crawlRenderJs}
            onCheckedChange={(value) => set('crawlRenderJs', value)}
          />
        </div>
      </div>

      {draft.crawlRenderJs ? (
        <Alert variant="info">
          <AlertTitle>JS rendering needs a browser on the worker</AlertTitle>
          <AlertDescription>
            The worker process must have a headless browser available and rendering enabled in its
            environment. Without it, crawls fall back to raw HTML rather than failing — check the
            crawl summary to see which mode actually ran.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2">
        <ListField
          id={`${ids}-include`}
          label="Include patterns"
          value={draft.crawlIncludePatterns}
          onChange={(value) => set('crawlIncludePatterns', value)}
          placeholder={'/blog/*\n/docs/*'}
          description="One path pattern per line. With any pattern here the crawler visits matching URLs only — a fast way to audit one section, and a fast way to miss everything else. Leave empty to crawl the whole site."
        />

        <ListField
          id={`${ids}-exclude`}
          label="Exclude patterns"
          value={draft.crawlExcludePatterns}
          onChange={(value) => set('crawlExcludePatterns', value)}
          placeholder={'/cart/*\n/search?*\n/*.pdf'}
          description="One pattern per line, applied after the include list. Use it for infinite spaces — faceted search, calendars, carts — which otherwise consume the whole page budget before the real content is reached."
        />
      </div>
    </SettingsSection>
  );
}
