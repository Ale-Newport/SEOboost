'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { History, RefreshCw } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ApiError, apiPost } from '@/lib/api-client';

/** The shape `/api/integrations/[provider]/sync` returns for a connected provider. */
interface SyncResponse {
  provider: string;
  websiteId: string;
  job?: { enqueued: boolean; message: string };
  /** Returned instead of a job when the provider is not connected or is disabled. */
  status?: 'skipped';
  reason?: string;
  fix?: string;
}

export interface SyncSearchConsoleButtonProps {
  websiteId: string;
  /** Rolling window to pull, in days. Ignored when `backfill` is set. */
  days?: number;
  /**
   * Reach back over the full retention window instead of the recent one.
   *
   * This is the same endpoint with `backfill: true`, which the route turns into a `gsc.backfill`
   * job. It exists as a prop because there is no integration settings screen to send people to —
   * an empty state that says "start a backfill" has to be able to start one.
   */
  backfill?: boolean;
  /** Months of history to reach back over when `backfill` is set. The API caps this at 16. */
  months?: number;
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
}

/**
 * Queues a Search Console import for this site.
 *
 * A queued job that no worker will pick up is reported as a warning rather than a success: the
 * row exists, but nothing is going to process it, and telling someone "sync started" would leave
 * them refreshing a screen that never fills in.
 */
export function SyncSearchConsoleButton({
  websiteId,
  days = 90,
  backfill = false,
  months = 16,
  label = 'Sync Search Console',
  variant = 'default',
  size = 'sm',
}: SyncSearchConsoleButtonProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const sync = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await apiPost<SyncResponse>(
        '/api/integrations/GOOGLE_SEARCH_CONSOLE/sync',
        backfill ? { websiteId, backfill: true, months } : { websiteId, days },
      );

      if (result.status === 'skipped') {
        toast.warning(result.reason ?? 'Search Console is not connected for this site', {
          ...(result.fix === undefined ? {} : { description: result.fix }),
        });
      } else if (result.job?.enqueued === false) {
        toast.warning('Sync queued, but no worker is connected', {
          description: result.job.message,
        });
      } else {
        toast.success(
          backfill ? 'Search Console backfill started' : 'Search Console sync started',
          {
            description: backfill
              ? `Reaching back ${months} months. Google returns this in pages, so it can take a while — reload once it finishes.`
              : `Pulling the last ${days} days. Reload once it finishes.`,
          },
        );
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the sync');
    } finally {
      setBusy(false);
    }
  };

  const Icon = backfill ? History : RefreshCw;

  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => void sync()}
      loading={busy}
      loadingText={backfill ? 'Queueing the backfill' : 'Queueing the sync'}
    >
      <Icon aria-hidden="true" />
      {label}
    </Button>
  );
}
