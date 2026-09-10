'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ApiError, apiPost } from '@/lib/api-client';

/**
 * Restores what a change overwrote.
 *
 * Rollback writes the *recorded* previous values back through the same adapter that made the
 * change; it is not a guess at an inverse. The server refuses when no before-state was captured
 * or when the action type has no safe inverse, and that refusal is surfaced verbatim rather than
 * being softened — an operator needs to know the site was left as it is.
 */
export interface RollbackButtonProps {
  actionId: string;
  summary: string;
  targetUrl: string | null;
}

export function RollbackButton({
  actionId,
  summary,
  targetUrl,
}: RollbackButtonProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function rollback(): Promise<void> {
    setPending(true);
    try {
      await apiPost(`/api/actions/${actionId}/rollback`, {});
      toast.success('Rollback applied', {
        description: 'The recorded previous values were written back to the site.',
      });
      router.refresh();
    } catch (cause) {
      const message =
        cause instanceof ApiError ? cause.message : 'The change was left exactly as it is.';
      toast.error('Rollback failed', { description: message });
      // Rethrown so the dialog stays open and shows the failure inline.
      throw cause;
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 text-xs"
        onClick={() => setOpen(true)}
        disabled={pending}
      >
        <Undo2 aria-hidden="true" />
        Roll back
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        destructive
        title="Roll this change back?"
        confirmLabel="Roll back"
        description={
          <>
            <span className="block">{summary}</span>
            {targetUrl ? (
              <span className="mt-1 block break-all font-mono text-2xs text-muted-foreground">
                {targetUrl}
              </span>
            ) : null}
            <span className="mt-2 block">
              The values recorded before the change are written back through the same integration
              that applied it. This is itself a change, and it is recorded in this timeline.
            </span>
          </>
        }
        onConfirm={rollback}
      />
    </>
  );
}
