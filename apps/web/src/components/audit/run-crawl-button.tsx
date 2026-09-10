'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Play } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ApiError, apiPost } from '@/lib/api-client';

interface StartCrawlResponse {
  queued: boolean;
  enqueued: boolean;
  message: string;
}

export interface RunCrawlButtonProps {
  websiteId: string;
  label?: string;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  /** A crawl is already queued or running, so starting another would only create noise. */
  disabled?: boolean;
}

/**
 * Starts a crawl and refreshes the audit, which has nothing to show until one has run.
 *
 * A queued job with no worker attached is reported as a warning rather than a success: the row
 * exists, but nothing is going to process it, and silently claiming "crawl started" would leave
 * someone waiting on a screen that never fills in.
 */
export function RunCrawlButton({
  websiteId,
  label = 'Run a crawl',
  variant = 'default',
  size = 'sm',
  disabled = false,
}: RunCrawlButtonProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const result = await apiPost<StartCrawlResponse>(`/api/websites/${websiteId}/crawl`, {});
      if (result.enqueued === false) {
        toast.warning('Crawl queued, but no worker is connected', { description: result.message });
      } else {
        toast.success('Crawl started', {
          description: 'Findings appear here as pages are audited.',
        });
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the crawl');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant={variant}
      size={size}
      onClick={() => void start()}
      loading={busy}
      loadingText="Starting the crawl"
      disabled={disabled}
    >
      <Play aria-hidden="true" />
      {label}
    </Button>
  );
}
