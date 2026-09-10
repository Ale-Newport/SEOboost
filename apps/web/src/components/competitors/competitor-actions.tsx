'use client';

import { useCallback, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, apiDelete, apiPost } from '@/lib/api-client';

interface EnqueueLike {
  enqueued?: boolean;
  message?: string;
}

/** One toast vocabulary for every "we queued a job" reply, including the no-broker case. */
function reportEnqueue(result: EnqueueLike, success: string): void {
  if (result.enqueued === false) {
    toast.warning('Recorded, but no worker picked it up', {
      description:
        result.message ??
        'No queue broker is reachable. Set REDIS_URL and start the worker, then retry from the Jobs screen.',
    });
    return;
  }
  toast.success(success);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Add competitor
// ---------------------------------------------------------------------------

export function AddCompetitorDialog({
  websiteId,
  serpConfigured,
}: {
  websiteId: string;
  serpConfigured: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState('');
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [analyse, setAnalyse] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const analyseId = useId();

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (pending) return;
      setPending(true);
      setError(null);
      try {
        const result = await apiPost<{ message?: string; analysis: EnqueueLike | null }>(
          `/api/websites/${websiteId}/competitors`,
          {
            domain: domain.trim(),
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
            analyse: analyse && serpConfigured,
          },
        );
        toast.success(result.message ?? 'Competitor saved.');
        if (result.analysis) reportEnqueue(result.analysis, 'Competitor analysis queued');
        setOpen(false);
        setDomain('');
        setName('');
        setNotes('');
        router.refresh();
      } catch (cause) {
        setError(messageOf(cause, 'Could not add this competitor.'));
      } finally {
        setPending(false);
      }
    },
    [analyse, domain, name, notes, pending, router, serpConfigured, websiteId],
  );

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        Add competitor
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Track a competitor</DialogTitle>
            <DialogDescription>
              Add the domain of a site you compete with in search. The analysis compares their
              observed rankings against yours to find shared keywords and gaps.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={submit} className="space-y-4">
            <FormField
              label="Domain"
              required
              description="Root domain only — no protocol, no path. For example competitor.com"
              {...(error ? { error } : {})}
            >
              <Input
                value={domain}
                onChange={(event) => setDomain(event.target.value)}
                placeholder="competitor.com"
                autoComplete="off"
                autoFocus
                required
              />
            </FormField>

            <FormField label="Display name" description="Optional — defaults to the domain.">
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Competitor Inc."
                autoComplete="off"
              />
            </FormField>

            <FormField label="Notes" description="Why you track them; visible only to your team.">
              <Textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={2}
                placeholder="Closest overlap on comparison queries."
              />
            </FormField>

            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3">
              <Checkbox
                id={analyseId}
                checked={analyse && serpConfigured}
                disabled={!serpConfigured}
                onCheckedChange={(checked) => setAnalyse(checked === true)}
                className="mt-0.5"
              />
              <div className="space-y-0.5">
                <Label htmlFor={analyseId} className="cursor-pointer">
                  Analyse straight away
                </Label>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {serpConfigured
                    ? 'Queues a SERP-backed analysis so the keyword overlap appears without waiting for the next scheduled run.'
                    : 'Unavailable: no SERP provider is configured, so competitor rankings cannot be collected. Set DATAFORSEO_LOGIN, SERPAPI_KEY or SERPER_API_KEY.'}
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" loading={pending} loadingText="Saving">
                Add competitor
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Run the analysis
// ---------------------------------------------------------------------------

export function RunCompetitorAnalysisButton({
  websiteId,
  disabled,
}: {
  websiteId: string;
  disabled?: boolean;
}): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const run = useCallback(async () => {
    setPending(true);
    try {
      const result = await apiPost<EnqueueLike>(`/api/websites/${websiteId}/automations`, {
        op: 'run-agent',
        agent: 'competitor',
      });
      reportEnqueue(result, 'Competitor analysis queued');
      router.refresh();
    } catch (cause) {
      toast.error(messageOf(cause, 'Could not queue the competitor analysis.'));
    } finally {
      setPending(false);
    }
  }, [router, websiteId]);

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={run}
      loading={pending}
      loadingText="Queueing"
      disabled={disabled === true}
    >
      <RefreshCw aria-hidden="true" />
      Run analysis
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export function RemoveCompetitorButton({
  websiteId,
  competitorId,
  domain,
}: {
  websiteId: string;
  competitorId: string;
  domain: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const remove = useCallback(async () => {
    await apiDelete(`/api/websites/${websiteId}/competitors/${competitorId}`);
    toast.success(`${domain} is no longer tracked`);
    router.refresh();
  }, [competitorId, domain, router, websiteId]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-destructive"
        aria-label={`Stop tracking ${domain}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 aria-hidden="true" className="size-3.5" />
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={remove}
        destructive
        title={`Stop tracking ${domain}?`}
        description="Every ranking and page observed for this competitor is deleted with it, so past gap analyses will no longer cite them. You can add the domain again later, but the observations start from scratch."
        confirmLabel="Stop tracking"
      />
    </>
  );
}
