'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { apiPost } from '@/lib/api-client';
import { reportApiError, reportJobResult, type JobResponse } from '@/lib/job-feedback';

/**
 * Queue one social agent through the generic `POST /api/agents/[name]/run`.
 *
 * Disabled with the reason on hover when the run could not do anything useful (no AI provider,
 * no topics, no connected account) — the operator learns why now rather than one job later.
 */
export function RunAgentButton({
  websiteId,
  agent,
  label,
  queuedTitle,
  icon: Icon,
  blockedReason,
  input,
  variant = 'outline',
  size = 'sm',
}: {
  websiteId: string;
  agent: string;
  label: string;
  queuedTitle: string;
  icon: LucideIcon;
  blockedReason: string | null;
  input?: Record<string, unknown>;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const result = await apiPost<JobResponse>(`/api/agents/${agent}/run`, { websiteId, input: input ?? {} });
      if (reportJobResult(result, queuedTitle)) router.refresh();
    } catch (error) {
      reportApiError(error, `Could not queue ${label.toLowerCase()}.`);
    } finally {
      setBusy(false);
    }
  }, [agent, input, label, queuedTitle, router, websiteId]);

  const button = (
    <Button
      variant={variant}
      size={size}
      onClick={() => void run()}
      loading={busy}
      loadingText={`Queueing ${label.toLowerCase()}`}
      disabled={blockedReason !== null}
    >
      {busy ? null : <Icon aria-hidden="true" />}
      {label}
    </Button>
  );

  return blockedReason === null ? (
    button
  ) : (
    <SimpleTooltip content={<span className="block max-w-xs">{blockedReason}</span>}>
      {/* A disabled button fires no pointer events, so the tooltip needs a wrapper to hover. */}
      <span className="inline-flex">{button}</span>
    </SimpleTooltip>
  );
}
