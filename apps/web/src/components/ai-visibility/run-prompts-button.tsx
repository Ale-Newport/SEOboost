'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play, Wand2 } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { apiPost } from '@/lib/api-client';
import { reportApiError, reportJobResult, type JobResponse } from '@/lib/job-feedback';

/**
 * The two background jobs this screen can queue.
 *
 * Both are disabled — with the reason on hover — when the installation has no AI provider or the
 * site has no active prompts, because the API would only refuse and the operator would learn that
 * one round-trip later. Neither ever scrapes a consumer chat interface: they call provider APIs,
 * and everything else arrives through the manual import panel.
 */

function Blocked({ reason, children }: { reason: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <SimpleTooltip content={reason}>
      {/* A disabled button fires no pointer events, so the tooltip needs a wrapper to hover. */}
      <span className="inline-flex">{children}</span>
    </SimpleTooltip>
  );
}

export function RunPromptsButton({
  websiteId,
  aiConfigured,
  activePrompts,
  variant = 'default',
  size = 'sm',
}: {
  websiteId: string;
  aiConfigured: boolean;
  activePrompts: number;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const result = await apiPost<JobResponse>('/api/ai-visibility/run', { websiteId });
      if (reportJobResult(result, 'Prompt run queued')) router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not queue the prompt run.');
    } finally {
      setBusy(false);
    }
  }, [websiteId, router]);

  const blockedReason = !aiConfigured
    ? 'No AI provider is configured on this installation, so no prompt can be queried. Record answers with the manual import panel instead.'
    : activePrompts === 0
      ? 'No active prompts to run. Add one, or discover a starting set.'
      : null;

  const button = (
    <Button
      variant={variant}
      size={size}
      onClick={() => void run()}
      loading={busy}
      loadingText="Queueing the run"
      disabled={blockedReason !== null}
    >
      {busy ? null : <Play aria-hidden="true" />}
      Run now
    </Button>
  );

  return blockedReason === null ? button : <Blocked reason={blockedReason}>{button}</Blocked>;
}

export function DiscoverPromptsButton({
  websiteId,
  aiConfigured,
  variant = 'outline',
  size = 'sm',
}: {
  websiteId: string;
  aiConfigured: boolean;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      const result = await apiPost<JobResponse>('/api/ai-visibility/discover', { websiteId });
      if (reportJobResult(result, 'Prompt discovery queued')) router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not queue prompt discovery.');
    } finally {
      setBusy(false);
    }
  }, [websiteId, router]);

  const button = (
    <Button
      variant={variant}
      size={size}
      onClick={() => void run()}
      loading={busy}
      loadingText="Queueing discovery"
      disabled={!aiConfigured}
    >
      {busy ? null : <Wand2 aria-hidden="true" />}
      Discover prompts
    </Button>
  );

  return aiConfigured ? (
    button
  ) : (
    <Blocked reason="Discovery reads this site's keywords and knowledge base through a model. Without an AI key it cannot run — add prompts by hand instead.">
      {button}
    </Blocked>
  );
}
