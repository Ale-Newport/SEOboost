import Link from 'next/link';
import { Bot, Cpu, ExternalLink, User } from 'lucide-react';

import { Badge, humanizeStatus } from '@/components/ui/badge';
import { Delta } from '@/components/ui/delta';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { FieldDiff } from '@/components/approvals/diff-view';
import { cn, shortenUrl } from '@/lib/utils';
import type { HistoryEntry } from '@/components/history/queries';
import { RollbackButton } from '@/components/history/rollback-button';

/**
 * One row of the audit trail.
 *
 * The diff reuses the approvals renderer (`FieldDiff`, which is a word-level LCS diff owned by
 * this codebase — no diff dependency), so a change looks identical whether you are approving it
 * or reading it back a month later. Nothing here is derived: an entry with no recorded snapshot
 * says that instead of rendering an empty diff.
 */

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Change types that describe the workflow rather than an edit to the site. */
const WORKFLOW_TYPES: Record<string, string> = {
  ACTION_PROPOSED: 'Proposed',
  ACTION_REJECTED: 'Rejected',
  ACTION_APPROVED: 'Approved',
  ROLLBACK: 'Rollback',
};

function changeTypeLabel(type: string): string {
  return WORKFLOW_TYPES[type] ?? humanizeStatus(type);
}

function actorIcon(actor: string) {
  if (actor === 'agent') return Bot;
  if (actor === 'user') return User;
  return Cpu;
}

/** Experiment outcomes read as their own sentence; a raw enum in the middle of prose does not. */
function outcomeTone(status: string | null): 'success' | 'destructive' | 'warning' | 'muted' {
  if (status === 'IMPROVED' || status === 'LIKELY_POSITIVE' || status === 'POSITIVE') return 'success';
  if (status === 'REGRESSED' || status === 'LIKELY_NEGATIVE' || status === 'NEGATIVE') return 'destructive';
  if (status === 'INCONCLUSIVE' || status === 'PENDING') return 'warning';
  return 'muted';
}

export function ChangeEntry({ entry }: { entry: HistoryEntry }): React.JSX.Element {
  const ActorIcon = actorIcon(entry.actor);
  const rolledBack = entry.rolledBackAt !== null;
  const canRollBack = entry.rollbackable && entry.actionId !== null && !rolledBack;

  return (
    <li className="relative pl-8">
      {/* Timeline rail: a dot on a line drawn by the parent list. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute left-[9px] top-[7px] size-2.5 rounded-full border-2 border-background',
          rolledBack ? 'bg-warning' : entry.approved ? 'bg-success' : 'bg-muted-foreground/60',
        )}
      />

      <article className="space-y-1.5 pb-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <time
            dateTime={entry.createdAt.toISOString()}
            className="tabular text-2xs font-medium text-muted-foreground"
          >
            {TIME.format(entry.createdAt)}
          </time>

          <span className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
            <ActorIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
            {entry.actorLabel}
          </span>

          <Badge variant="outline" className="font-normal">
            {changeTypeLabel(entry.changeType)}
          </Badge>

          {entry.approved ? (
            <Badge variant="success" className="font-normal">
              Approved
            </Badge>
          ) : (
            <Badge variant="muted" className="font-normal">
              Not approved
              <TooltipInfo
                content="No human approval is recorded against this entry. Either the autonomy level let it execute directly, or it never needed one — a proposal or a rejection changes nothing on the site."
                label="Why this entry is marked not approved"
              />
            </Badge>
          )}

          {rolledBack ? (
            <Badge variant="warning" className="font-normal">
              Rolled back
            </Badge>
          ) : null}

          {canRollBack && entry.actionId !== null ? (
            <span className="ml-auto">
              <RollbackButton
                actionId={entry.actionId}
                summary={entry.summary}
                targetUrl={entry.targetUrl}
              />
            </span>
          ) : null}
        </div>

        <p className="text-sm leading-relaxed text-foreground">{entry.summary}</p>

        {entry.targetUrl ? (
          <a
            href={entry.targetUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex max-w-full items-center gap-1 break-all font-mono text-2xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {shortenUrl(entry.targetUrl, 72)}
            <ExternalLink aria-hidden="true" className="size-3 shrink-0" />
          </a>
        ) : null}

        {entry.reason ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{entry.reason}</p>
        ) : null}

        {entry.outcome ? <OutcomeRow entry={entry} /> : null}

        {entry.diff.length > 0 ? (
          <details className="group rounded-md border border-border bg-card/40">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-foreground marker:content-none">
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="text-muted-foreground transition-transform group-open:rotate-90"
                >
                  ›
                </span>
                What changed ({entry.diff.length} field{entry.diff.length === 1 ? '' : 's'})
              </span>
            </summary>
            <div className="space-y-2 border-t border-border p-3">
              {entry.diff.map((field) => (
                <div key={field.field} className="space-y-1">
                  <FieldDiff field={field.field} before={field.before} after={field.after} />
                  {field.truncated ? (
                    <p className="text-2xs text-muted-foreground">
                      This value was longer than the render budget and is shown cut short. The full
                      text is in the stored change record.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </details>
        ) : entry.hasSnapshot ? (
          <p className="text-2xs text-muted-foreground">
            A before/after snapshot was recorded, but the two are identical — this entry changed no
            field values.
          </p>
        ) : (
          <p className="text-2xs text-muted-foreground">
            No before/after snapshot was recorded for this entry
            {entry.actionId ? (
              <>
                .{' '}
                <Link
                  href={`/actions/${entry.actionId}`}
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Open the action
                </Link>{' '}
                for its payload and execution log.
              </>
            ) : (
              ', so there is nothing to diff.'
            )}
          </p>
        )}
      </article>
    </li>
  );
}

/** The measured result, where one exists. Never a projection — only what was evaluated. */
function OutcomeRow({ entry }: { entry: HistoryEntry }): React.JSX.Element | null {
  const outcome = entry.outcome;
  if (!outcome) return null;

  const measured = outcome.measuredAt;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-muted/30 px-2.5 py-1.5">
      <span className="inline-flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        Measured result
        <TooltipInfo
          label="How this result was measured"
          content={
            outcome.source === 'experiment'
              ? 'Taken from the experiment attached to this action: the metric was compared between the baseline window before the change and the measurement window after it.'
              : 'Taken from the result metrics recorded on this change entry by whatever evaluated it.'
          }
        />
      </span>

      {outcome.metric ? (
        <span className="text-2xs text-muted-foreground">{outcome.metric}</span>
      ) : null}

      {outcome.deltaPct !== null ? (
        <Delta value={outcome.deltaPct} comparisonLabel="versus the baseline window" />
      ) : null}

      {outcome.status ? (
        <Badge variant={outcomeTone(outcome.status)} className="font-normal">
          {humanizeStatus(outcome.status)}
        </Badge>
      ) : null}

      {outcome.significance !== null ? (
        <span className="tabular text-2xs text-muted-foreground">
          p = {outcome.significance.toFixed(3)}
        </span>
      ) : null}

      {outcome.extra.map((metric) => (
        <span key={metric.label} className="text-2xs text-muted-foreground">
          {metric.label}: <span className="tabular text-foreground">{metric.value}</span>
        </span>
      ))}

      {measured ? (
        <span className="text-2xs text-muted-foreground">
          evaluated {measured.toISOString().slice(0, 10)}
        </span>
      ) : null}

      {outcome.interpretation ? (
        <p className="basis-full text-2xs leading-relaxed text-muted-foreground">
          {outcome.interpretation}
        </p>
      ) : null}
    </div>
  );
}
