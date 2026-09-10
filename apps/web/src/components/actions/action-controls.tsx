'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, FlaskConical, Play, Undo2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { apiPost } from '@/lib/api-client';

/**
 * The four decisions available on one action.
 *
 * Every button that is unavailable stays visible and says why: an operator needs to know that
 * execution is blocked by the site's autonomy level, not that the button vanished. The same
 * guardrail is enforced again server-side — this is the explanation, not the enforcement.
 */

export interface ActionControlsProps {
  actionId: string;
  status: string;
  /** True once a human (or a prior bulk approval) has signed this off. */
  approved: boolean;
  /** `evaluateGuardrail` for this action type at this site's autonomy level. */
  guardrail: { allowed: boolean; reason: string; requiresApproval: boolean };
  /** Null when a rollback is possible; otherwise the reason it is not. */
  rollbackBlockedReason: string | null;
}

const DECIDED = new Set(['EXECUTING', 'COMPLETED', 'ROLLED_BACK', 'CANCELLED']);
const NOT_EXECUTABLE = new Set(['EXECUTING', 'COMPLETED', 'REJECTED', 'CANCELLED', 'ROLLED_BACK']);

type Busy = 'approve' | 'reject' | 'execute' | 'dry-run' | 'rollback' | null;

function message(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Please try again.';
}

export function ActionControls({
  actionId,
  status,
  approved,
  guardrail,
  rollbackBlockedReason,
}: ActionControlsProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<Busy>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rollbackOpen, setRollbackOpen] = useState(false);
  const [note, setNote] = useState('');

  const canDecide = !DECIDED.has(status) && status !== 'REJECTED';
  const canExecute = !NOT_EXECUTABLE.has(status) && (approved || guardrail.allowed);
  const executeBlockedReason = NOT_EXECUTABLE.has(status)
    ? `This action is ${status.toLowerCase().replace(/_/g, ' ')} and cannot be executed again.`
    : guardrail.reason;

  async function approve(): Promise<void> {
    setBusy('approve');
    try {
      await apiPost(`/api/actions/${actionId}/approve`, {});
      toast.success('Action approved', { description: 'Run it when you are ready to apply the change.' });
      router.refresh();
    } catch (error) {
      toast.error('Could not approve this action', { description: message(error) });
    } finally {
      setBusy(null);
    }
  }

  async function reject(): Promise<void> {
    setBusy('reject');
    try {
      await apiPost(`/api/actions/${actionId}/reject`, { ...(note.trim() ? { note: note.trim() } : {}) });
      toast.success('Action rejected', { description: 'It stays on record and feeds the prioritisation loop.' });
      setRejectOpen(false);
      setNote('');
      router.refresh();
    } catch (error) {
      toast.error('Could not reject this action', { description: message(error) });
    } finally {
      setBusy(null);
    }
  }

  async function execute(dryRun: boolean): Promise<void> {
    setBusy(dryRun ? 'dry-run' : 'execute');
    try {
      await apiPost(`/api/actions/${actionId}/execute`, dryRun ? { dryRun: true } : {});
      toast.success(dryRun ? 'Dry run queued' : 'Execution queued', {
        description: dryRun
          ? 'Every guard runs and the diff is produced, but nothing is written to the live site.'
          : 'Follow it on the Jobs screen; the execution history below updates when it finishes.',
      });
      router.refresh();
    } catch (error) {
      toast.error(dryRun ? 'Dry run refused' : 'Could not queue this action', { description: message(error) });
    } finally {
      setBusy(null);
    }
  }

  async function rollback(): Promise<void> {
    setBusy('rollback');
    try {
      await apiPost(`/api/actions/${actionId}/rollback`, {});
      toast.success('Rollback applied', { description: 'The recorded previous values were written back.' });
      router.refresh();
    } catch (error) {
      // Rethrown so ConfirmDialog keeps itself open and shows the failure inline.
      toast.error('Rollback failed', { description: message(error) });
      throw error;
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {canDecide ? (
        <>
          <Button
            variant="outline"
            size="sm"
            loading={busy === 'approve'}
            loadingText="Approving"
            disabled={busy !== null || approved}
            onClick={() => void approve()}
          >
            <Check aria-hidden="true" />
            {approved ? 'Approved' : 'Approve'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => {
              setNote('');
              setRejectOpen(true);
            }}
          >
            <X aria-hidden="true" />
            Reject
          </Button>
        </>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        loading={busy === 'dry-run'}
        loadingText="Queuing dry run"
        disabled={busy !== null || NOT_EXECUTABLE.has(status)}
        onClick={() => void execute(true)}
      >
        <FlaskConical aria-hidden="true" />
        Dry run
      </Button>

      {canExecute ? (
        <Button
          size="sm"
          loading={busy === 'execute'}
          loadingText="Queuing"
          disabled={busy !== null}
          onClick={() => void execute(false)}
        >
          <Play aria-hidden="true" />
          Execute
        </Button>
      ) : (
        <SimpleTooltip content={executeBlockedReason}>
          {/* A disabled button swallows pointer events, so the tooltip needs a wrapper to hover. */}
          <span className="inline-flex" tabIndex={0} role="button" aria-disabled="true">
            <Button size="sm" disabled>
              <Play aria-hidden="true" />
              Execute
            </Button>
          </span>
        </SimpleTooltip>
      )}

      {rollbackBlockedReason === null ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          onClick={() => setRollbackOpen(true)}
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
        >
          <Undo2 aria-hidden="true" />
          Roll back
        </Button>
      ) : (
        <SimpleTooltip content={rollbackBlockedReason}>
          <span className="inline-flex" tabIndex={0} role="button" aria-disabled="true">
            <Button variant="ghost" size="sm" disabled>
              <Undo2 aria-hidden="true" />
              Roll back
            </Button>
          </span>
        </SimpleTooltip>
      )}

      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this action</DialogTitle>
            <DialogDescription>
              The action is kept and marked rejected. Any approval still open on it is closed with
              your note, and the rejection feeds back into how similar proposals are prioritised.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="action-reject-note">Note (optional)</Label>
            <Textarea
              id="action-reject-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="e.g. the title is already being changed by the marketing team"
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRejectOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={busy === 'reject'}
              loadingText="Rejecting"
              onClick={() => void reject()}
            >
              Reject action
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        destructive
        confirmationText="ROLLBACK"
        title="Roll this change back?"
        description="The values recorded before the change was applied will be written back to the live site through the same adapter. A new execution row is added and the change log entries are marked reverted."
        confirmLabel="Roll back"
        onConfirm={rollback}
      />
    </div>
  );
}
