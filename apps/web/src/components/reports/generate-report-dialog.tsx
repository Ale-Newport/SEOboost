'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Plus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ApiError, apiPost } from '@/lib/api-client';

export interface GenerateReportSite {
  id: string;
  name: string;
}

type ReportType = 'weekly' | 'monthly' | 'quarterly' | 'portfolio' | 'custom';

const REPORT_TYPES: ReadonlyArray<{ value: ReportType; label: string; hint: string }> = [
  { value: 'weekly', label: 'Weekly', hint: 'The last seven complete days for one site.' },
  { value: 'monthly', label: 'Monthly', hint: 'The last complete calendar month for one site.' },
  { value: 'quarterly', label: 'Quarterly', hint: 'The last complete quarter for one site.' },
  { value: 'portfolio', label: 'Portfolio', hint: 'Every site you own, rolled up into one report.' },
  { value: 'custom', label: 'Custom period', hint: 'Any window you choose, for one site.' },
];

interface GenerateResponse {
  job?: { enqueued: boolean; message: string };
}

/** `2026-09-09` for an `<input type="date">` default. */
function dateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Queues a report.
 *
 * Generation runs in the worker, so this dialog never claims a report is ready — it says the
 * job was queued, and it says loudly when no broker accepted it, because in that case nothing
 * will ever produce the report until a worker connects.
 */
export function GenerateReportDialog({
  sites,
  triggerLabel = 'Generate report',
}: {
  sites: readonly GenerateReportSite[];
  triggerLabel?: string;
}): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [type, setType] = React.useState<ReportType>('weekly');
  const [websiteId, setWebsiteId] = React.useState<string>(sites[0]?.id ?? '');
  const [periodStart, setPeriodStart] = React.useState(() =>
    dateInputValue(new Date(Date.now() - 28 * 86_400_000)),
  );
  const [periodEnd, setPeriodEnd] = React.useState(() => dateInputValue(new Date()));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const needsSite = type !== 'portfolio';
  const needsPeriod = type === 'custom';
  const activeType = REPORT_TYPES.find((entry) => entry.value === type) ?? REPORT_TYPES[0];
  const invalidPeriod = needsPeriod && periodStart !== '' && periodEnd !== '' && periodStart > periodEnd;

  const submit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending) return;

    if (needsSite && websiteId === '') {
      setError('Choose the website this report covers.');
      return;
    }
    if (invalidPeriod) {
      setError('The start of the period must be on or before its end.');
      return;
    }

    setPending(true);
    setError(null);
    try {
      const response = await apiPost<GenerateResponse>('/api/reports/generate', {
        type,
        ...(needsSite ? { websiteId } : {}),
        ...(needsPeriod ? { periodStart, periodEnd } : {}),
      });

      if (response.job && response.job.enqueued === false) {
        toast.warning('Report recorded but not queued', {
          description:
            response.job.message ||
            'No queue broker is reachable, so no worker will generate this report. Set REDIS_URL and start the worker.',
        });
      } else {
        toast.success('Report queued', {
          description: 'It will appear in this list as soon as the worker finishes generating it.',
        });
      }
      setOpen(false);
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiError ? err.message : 'Could not queue the report.';
      setError(message);
      toast.error(message);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus aria-hidden="true" />
          {triggerLabel}
        </Button>
      </DialogTrigger>

      <DialogContent>
        <form onSubmit={(event) => void submit(event)} className="contents">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="size-4 text-muted-foreground" aria-hidden="true" />
              Generate a report
            </DialogTitle>
            <DialogDescription>
              The worker builds the report from data already in the database — organic performance,
              detected problems, agent activity and experiment results for the period.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <FormField label="Report type" description={activeType?.hint}>
              <Select value={type} onValueChange={(value) => setType(value as ReportType)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a report type" />
                </SelectTrigger>
                <SelectContent>
                  {REPORT_TYPES.map((entry) => (
                    <SelectItem key={entry.value} value={entry.value}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>

            {needsSite ? (
              <FormField
                label="Website"
                required
                description={
                  sites.length === 0 ? 'Add a website before generating a site report.' : undefined
                }
              >
                <Select
                  value={websiteId}
                  onValueChange={setWebsiteId}
                  disabled={sites.length === 0}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Choose a website" />
                  </SelectTrigger>
                  <SelectContent>
                    {sites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            ) : null}

            {needsPeriod ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="Period start" required>
                  <Input
                    type="date"
                    value={periodStart}
                    max={periodEnd || undefined}
                    onChange={(event) => setPeriodStart(event.target.value)}
                  />
                </FormField>
                <FormField label="Period end" required error={invalidPeriod ? 'Must be after the start.' : undefined}>
                  <Input
                    type="date"
                    value={periodEnd}
                    min={periodStart || undefined}
                    onChange={(event) => setPeriodEnd(event.target.value)}
                  />
                </FormField>
              </div>
            ) : null}

            {error ? (
              <p role="alert" className="text-xs font-medium text-destructive">
                {error}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} loadingText="Queueing the report">
              Queue report
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
