'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, CalendarClock, Pencil, Play } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { CRON_PRESETS, describeCron } from '@/components/automations/cron-text';
import type { AutomationsData } from '@/components/automations/queries';

type Schedule = AutomationsData['schedules'][number];

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** What each managed schedule actually does, in the operator's language. */
const SCHEDULE_PURPOSE: Record<string, string> = {
  crawl: 'Re-crawls the site so the page inventory, technical audit and link graph stay current.',
  'gsc-sync': 'Pulls the latest Search Console clicks, impressions, positions and query data.',
  analysis: 'Recomputes page and site scores, then re-runs the analysis that produces actions.',
  'ai-visibility': 'Runs the tracked prompt set against your AI providers and records mentions.',
  report: 'Generates the periodic performance report for this site.',
};

const CUSTOM_VALUE = '__custom__';

export interface ScheduleListProps {
  websiteId: string;
  schedules: readonly Schedule[];
  queueConfigured: boolean;
}

export function ScheduleList({
  websiteId,
  schedules,
  queueConfigured,
}: ScheduleListProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<Schedule | null>(null);

  const post = useCallback(
    async (body: Record<string, unknown>, key: string, onSuccess: (message: string) => void) => {
      setBusy(key);
      try {
        const result = await apiPost<{ message?: string; enqueued?: boolean }>(
          `/api/websites/${websiteId}/automations`,
          body,
        );
        if (result.enqueued === false) {
          toast.warning('Recorded, but no worker picked it up', {
            description:
              result.message ??
              'No queue broker is reachable. Set REDIS_URL and start the worker, then retry from the Jobs screen.',
          });
        } else {
          onSuccess(result.message ?? 'Done.');
        }
        router.refresh();
        return true;
      } catch (cause) {
        toast.error(cause instanceof ApiError ? cause.message : 'Could not update the schedule.');
        return false;
      } finally {
        setBusy(null);
      }
    },
    [router, websiteId],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock aria-hidden="true" className="size-4 text-primary" />
          Schedules
        </CardTitle>
        <CardDescription>
          Recurring work for this site. Cron times are interpreted in UTC — the same clock the
          worker uses — so what you see here is what fires.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {!queueConfigured ? (
          <Alert variant="warning">
            <AlertTitle>No queue broker is connected</AlertTitle>
            <AlertDescription>
              Schedules are stored and shown here, but nothing will run them: set{' '}
              <code className="font-mono text-2xs">REDIS_URL</code> and start the worker process.
              Until then, &ldquo;Run now&rdquo; records the job without executing it.
            </AlertDescription>
          </Alert>
        ) : null}

        {schedules.length === 0 ? (
          <EmptyState
            size="sm"
            bordered
            icon={CalendarClock}
            title="No schedules for this site"
            description="Every managed schedule is off. Turn one on from Settings → Crawler and AI, or set a cron expression there — the rows appear here as soon as one exists."
          />
        ) : (
          <ul className="divide-y divide-border">
            {schedules.map((schedule) => {
              const description = describeCron(schedule.cron);
              const key = schedule.id;
              const running = busy === key;

              return (
                <li key={schedule.id} className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-medium text-foreground">{schedule.label}</h3>
                      {schedule.managed ? null : (
                        <Badge variant="outline" className="text-2xs">
                          Custom
                        </Badge>
                      )}
                      {schedule.cronValid ? null : (
                        <Badge variant="destructive" className="text-2xs">
                          Invalid cron
                        </Badge>
                      )}
                      {schedule.lastStatus && schedule.lastStatus.startsWith('NOT_QUEUED') ? (
                        <Badge variant="warning" className="text-2xs">
                          Last run not queued
                        </Badge>
                      ) : null}
                    </div>

                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                      {SCHEDULE_PURPOSE[schedule.name] ?? `Runs the ${schedule.jobName} job.`}
                    </p>

                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
                      <span className={cn(schedule.isEnabled ? 'text-foreground' : undefined)}>
                        {description ?? 'Custom schedule'}
                      </span>
                      <code className="rounded bg-muted px-1 py-px font-mono">{schedule.cron}</code>
                      <span aria-hidden="true">·</span>
                      <span>
                        {schedule.isEnabled && schedule.nextRunAt
                          ? `Next ${DATE_TIME.format(new Date(schedule.nextRunAt))}`
                          : 'Off — no next run'}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {schedule.lastRunAt
                          ? `Last ${DATE_TIME.format(new Date(schedule.lastRunAt))}`
                          : 'Never run'}
                      </span>
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8"
                      onClick={() => setEditing(schedule)}
                      disabled={running}
                    >
                      <Pencil aria-hidden="true" />
                      <span className="sr-only sm:not-sr-only">Edit</span>
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      loading={running}
                      loadingText="Queueing"
                      onClick={() =>
                        void post({ op: 'run-schedule', scheduleId: schedule.id }, key, () =>
                          toast.success(`${schedule.label} queued`),
                        )
                      }
                    >
                      <Play aria-hidden="true" />
                      Run now
                    </Button>
                    <Switch
                      checked={schedule.isEnabled}
                      disabled={running || !schedule.cronValid}
                      aria-label={`${schedule.label} enabled`}
                      onCheckedChange={(next) =>
                        void post(
                          { op: 'toggle-schedule', scheduleId: schedule.id, enabled: next },
                          key,
                          (message) => toast.success(message),
                        )
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <EditScheduleDialog
        schedule={editing}
        onClose={() => setEditing(null)}
        onSave={async (cron) => {
          if (!editing) return false;
          return post({ op: 'update-schedule', scheduleId: editing.id, cron }, editing.id, (message) =>
            toast.success(message),
          );
        }}
      />
    </Card>
  );
}

function EditScheduleDialog({
  schedule,
  onClose,
  onSave,
}: {
  schedule: Schedule | null;
  onClose: () => void;
  onSave: (cron: string) => Promise<boolean>;
}): React.JSX.Element {
  const [cron, setCron] = useState('');
  const [pending, setPending] = useState(false);
  const open = schedule !== null;
  const current = schedule?.cron ?? '';
  const value = cron || current;
  const preset = CRON_PRESETS.some((entry) => entry.value === value) ? value : CUSTOM_VALUE;
  const description = describeCron(value);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCron('');
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reschedule {schedule?.label ?? 'job'}</DialogTitle>
          <DialogDescription>
            Pick a preset or write a five-field cron expression. Times are UTC.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormField label="Frequency">
            <Select
              value={preset}
              onValueChange={(next) => setCron(next === CUSTOM_VALUE ? value : next)}
            >
              <SelectTrigger aria-label="Frequency preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CRON_PRESETS.map((entry) => (
                  <SelectItem key={entry.value} value={entry.value}>
                    {entry.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_VALUE}>Custom expression…</SelectItem>
              </SelectContent>
            </Select>
          </FormField>

          <FormField
            label="Cron expression"
            description={
              description
                ? `Reads as: ${description}`
                : 'Five fields — minute hour day-of-month month day-of-week. It will be rejected if it does not parse.'
            }
          >
            <Input
              value={value}
              onChange={(event) => setCron(event.target.value)}
              className="font-mono"
              spellCheck={false}
              autoComplete="off"
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            loading={pending}
            loadingText="Saving"
            disabled={value.trim().length === 0 || value.trim() === current}
            onClick={async () => {
              setPending(true);
              const ok = await onSave(value.trim());
              setPending(false);
              if (ok) {
                setCron('');
                onClose();
              }
            }}
          >
            Save schedule
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Shown when a schedule fired but the broker refused the job. */
export function ScheduleWarningIcon(): React.JSX.Element {
  return <AlertTriangle aria-hidden="true" className="size-3.5 text-warning" />;
}
