'use client';

import * as React from 'react';
import { ArrowRight, Play, RotateCw, Waypoints } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { StatusBadge } from '@/components/ui/badge';
import { formatNumber } from '@/lib/utils';
import { getCrawlProgress, startFirstCrawl } from './actions';
import { StepFooter, StepHeader } from './step-shell';
import type { CrawlProgress, OnboardingWebsite } from './types';

const POLL_MS = 2500;
const IN_FLIGHT = new Set(['QUEUED', 'RUNNING', 'DELAYED']);

interface StepCrawlProps {
  site: OnboardingWebsite;
  onNext: () => void;
  onBack: () => void;
}

/** True while the job or the crawl it created is still moving. */
function isRunning(progress: CrawlProgress | null): boolean {
  if (!progress) return false;
  if (progress.jobStatus && IN_FLIGHT.has(progress.jobStatus)) return true;
  return Boolean(progress.crawl && IN_FLIGHT.has(progress.crawl.status));
}

export function StepCrawl({ site, onNext, onBack }: StepCrawlProps) {
  const [jobRecordId, setJobRecordId] = React.useState<string | null>(null);
  const [started, setStarted] = React.useState(false);
  const [starting, setStarting] = React.useState(false);
  const [noWorkerMessage, setNoWorkerMessage] = React.useState<string | null>(null);
  const [progress, setProgress] = React.useState<CrawlProgress | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const running = isRunning(progress);
  const completed = progress?.crawl?.status === 'COMPLETED';
  const failed = progress?.crawl?.status === 'FAILED' || progress?.jobStatus === 'FAILED';

  const poll = React.useCallback(async () => {
    const result = await getCrawlProgress({ websiteId: site.id, jobRecordId });
    if (result.ok) {
      setProgress(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
  }, [site.id, jobRecordId]);

  /*
   * Poll only while there is something in flight; a finished crawl stops costing requests.
   *
   * With no broker connected nothing will ever change, so the interval is skipped — but the
   * single read still happens, because `enqueue` wrote a real JobRecord and showing it is the
   * difference between "queued, waiting for a worker" and a step that looks like it did nothing.
   */
  React.useEffect(() => {
    if (!started) return;
    let disposed = false;

    const tick = () => {
      if (disposed) return;
      void poll();
    };

    tick();
    if (noWorkerMessage) {
      return () => {
        disposed = true;
      };
    }

    const interval = window.setInterval(() => {
      if (document.hidden) return;
      tick();
    }, POLL_MS);

    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [started, noWorkerMessage, poll]);

  React.useEffect(() => {
    // Once a reading comes back terminal — completed, failed or cancelled — stop the poller.
    if (started && progress && !running) setStarted(false);
  }, [started, progress, running]);

  const start = async () => {
    setError(null);
    setNoWorkerMessage(null);
    /*
     * Drop the previous reading before re-queueing. Retrying a failed crawl otherwise leaves a
     * terminal reading on screen, and the "stop polling once terminal" effect below would see
     * it and shut the new poller down before its first result arrived.
     */
    setProgress(null);
    setStarting(true);
    const result = await startFirstCrawl({ websiteId: site.id });
    setStarting(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    setJobRecordId(result.data.jobRecordId);
    if (!result.data.enqueued) setNoWorkerMessage(result.data.message);
    setStarted(true);
  };

  const crawl = progress?.crawl ?? null;
  const percent = progress && progress.jobProgress > 0 ? progress.jobProgress : null;
  const statusMessage = crawl?.progressMessage ?? progress?.jobMessage ?? null;

  return (
    <div>
      <StepHeader
        icon={Waypoints}
        title="Run the first crawl"
        description={`Fetches ${site.protocol}://${site.domain}, follows internal links within your crawl limits, and builds the page inventory, link graph and technical issue list everything else reads from.`}
      />

      <div className="mt-6 space-y-4">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="text-foreground">{error}</AlertDescription>
          </Alert>
        ) : null}

        {noWorkerMessage ? (
          <Alert variant="warning">
            <AlertTitle>Queued, but no worker is connected</AlertTitle>
            <AlertDescription>{noWorkerMessage}</AlertDescription>
          </Alert>
        ) : null}

        {!progress && !starting ? (
          <div className="rounded-md border border-border bg-muted/30 p-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              The crawl respects <code className="font-mono text-2xs">robots.txt</code> and the page,
              depth and rate limits in this site&rsquo;s settings. It runs in the background — you can
              leave this page and follow it on the Jobs screen.
            </p>
          </div>
        ) : null}

        {progress ? (
          <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={crawl?.status ?? progress.jobStatus ?? 'QUEUED'} />
              {statusMessage ? (
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {statusMessage}
                </span>
              ) : null}
            </div>

            <Progress
              value={percent}
              aria-label="Crawl progress"
              indicatorClassName={failed ? 'bg-destructive' : completed ? 'bg-success' : undefined}
            />

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { label: 'Discovered', value: crawl?.pagesDiscovered ?? 0 },
                { label: 'Crawled', value: crawl?.pagesCrawled ?? 0 },
                { label: 'Failed', value: crawl?.pagesFailed ?? 0 },
                { label: 'Issues found', value: crawl?.issuesFound ?? 0 },
              ].map((stat) => (
                <div key={stat.label}>
                  <dt className="text-2xs uppercase tracking-wide text-muted-foreground">{stat.label}</dt>
                  <dd className="tabular text-lg font-semibold leading-tight">{formatNumber(stat.value)}</dd>
                </div>
              ))}
            </dl>

            {crawl?.error ? (
              <p className="text-xs leading-relaxed text-destructive" role="alert">
                {crawl.error}
              </p>
            ) : null}
            {progress.jobError && !crawl?.error ? (
              <p className="text-xs leading-relaxed text-destructive" role="alert">
                {progress.jobError}
              </p>
            ) : null}
          </div>
        ) : null}

        {completed ? (
          <Alert variant="success">
            <AlertTitle>Crawl finished</AlertTitle>
            <AlertDescription>
              The technical audit, page scores and link graph are computed from this crawl.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>

      <StepFooter onBack={onBack} onSkip={running ? undefined : onNext} skipLabel="Skip and finish">
        {/* Keyed on `started`, not just `progress`: between queueing and the first reading there
            is nothing to show yet, and offering "Start crawl" again there only produces a
            duplicate the queue throws away. */}
        {starting ? (
          <Button loading loadingText="Queueing crawl">
            Queueing crawl
          </Button>
        ) : failed ? (
          <Button onClick={() => void start()} variant="outline">
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        ) : !started && !progress ? (
          <Button onClick={() => void start()}>
            <Play aria-hidden="true" />
            Start crawl
          </Button>
        ) : (
          <Button onClick={onNext}>
            {running ? 'Continue in the background' : 'Continue'}
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </StepFooter>
    </div>
  );
}
