'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Compass } from 'lucide-react';
import { Button, type ButtonProps } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { apiPost } from '@/lib/api-client';
import { reportApiError, reportJobResult, type JobResponse } from '@/lib/job-feedback';

/**
 * Queues `geo.audit`. The button is disabled — with the reason on hover — when the site has no
 * crawled content to score, because the API would only refuse and the operator would learn that
 * one round-trip later.
 */
export function RunGeoAuditButton({
  websiteId,
  auditablePages,
  label = 'Run GEO audit',
  variant = 'default',
  size = 'sm',
}: {
  websiteId: string;
  auditablePages: number;
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const blocked = auditablePages === 0;

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const result = await apiPost<JobResponse>('/api/geo/audit', { websiteId });
      if (reportJobResult(result, 'GEO audit queued')) router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not queue the GEO audit.');
    } finally {
      setBusy(false);
    }
  }, [websiteId, router]);

  const button = (
    <Button variant={variant} size={size} onClick={run} loading={busy} loadingText="Queueing the audit" disabled={blocked}>
      {busy ? null : <Compass aria-hidden="true" />}
      {label}
    </Button>
  );

  if (!blocked) return button;

  return (
    <SimpleTooltip content="Crawl the site first — the GEO score is computed from page content, so there is nothing to audit yet.">
      {/* A disabled button fires no pointer events, so the tooltip needs a wrapper to hover. */}
      <span className="inline-flex">{button}</span>
    </SimpleTooltip>
  );
}
