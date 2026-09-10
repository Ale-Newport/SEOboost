'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/textarea';
import { formatNumber } from '@/lib/utils';

/** The reasons an issue actually gets ignored, offered as one click each. */
const PRESET_REASONS = [
  'Intentional — this is how the site is meant to behave.',
  'False positive — the rule misreads this page.',
  'Accepted risk — the fix costs more than the problem.',
  'Handled elsewhere — tracked outside this tool.',
];

export interface IgnoreIssuesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** How many issues the decision covers. */
  count: number;
  /** Resolves true when every issue was updated; the dialog stays open otherwise. */
  onConfirm: (reason: string) => Promise<boolean>;
}

/**
 * Ignoring is a judgement call that someone will question in three months, so the reason is
 * mandatory — the API rejects a blank one, and this dialog will not let you send one either.
 */
export function IgnoreIssuesDialog({
  open,
  onOpenChange,
  count,
  onConfirm,
}: IgnoreIssuesDialogProps): React.JSX.Element {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A fresh prompt must never inherit the previous decision's wording.
  useEffect(() => {
    if (open) {
      setReason('');
      setError(null);
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setError('Say why this is being ignored — the decision is kept in the audit trail.');
      return;
    }
    setBusy(true);
    try {
      const ok = await onConfirm(trimmed);
      if (ok) onOpenChange(false);
      else setError('Not every issue could be updated. Check the notification and try again.');
    } finally {
      setBusy(false);
    }
  };

  const label = count === 1 ? 'this issue' : `${formatNumber(count)} issues`;

  return (
    <Dialog open={open} onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Ignore {label}</DialogTitle>
          <DialogDescription>
            Ignored issues stop counting towards the health score and drop out of the open list. The
            next crawl will not raise them again unless you reopen them.
          </DialogDescription>
        </DialogHeader>

        <FormField
          label="Why is this being ignored?"
          required
          description="Stored with the issue so anyone reviewing the audit later can see the call that was made."
          error={error}
        >
          <Textarea
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              if (error) setError(null);
            }}
            maxLength={500}
            rows={3}
            placeholder="e.g. These URLs are staging-only and are blocked at the edge."
          />
        </FormField>

        <div className="flex flex-wrap gap-1.5">
          {PRESET_REASONS.map((preset) => (
            <Button
              key={preset}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 border-dashed text-2xs font-normal"
              onClick={() => {
                setReason(preset);
                setError(null);
              }}
            >
              {preset.split(' — ')[0]}
            </Button>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} loadingText="Ignoring issues">
            Ignore {count === 1 ? 'issue' : `${formatNumber(count)} issues`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
