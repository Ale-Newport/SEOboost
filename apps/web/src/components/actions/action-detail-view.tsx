import Link from 'next/link';
import {
  Activity,
  Bot,
  CheckSquare,
  FileSearch,
  FlaskConical,
  Globe,
  History,
  Link2,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import type { ActionDetail, ActionGuardrail } from '@/server/queries/actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, StatusBadge, humanizeStatus } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { StatList, StatListItem } from '@/components/ui/stat-list';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { UrlCell } from '@/components/data/url-cell';
import { cn, formatDelta, formatNumber, formatPercent, formatUsd } from '@/lib/utils';
import { ActionControls } from './action-controls';
import { JsonView, hasJsonContent } from './json-view';
import { actionPriority } from './priority';
import { RiskBadge } from './risk-badge';

/**
 * Everything known about one proposed change.
 *
 * The screen is deliberately an audit trail rather than a summary: the reasoning, the evidence
 * the agent based it on, the exact URLs it touches, how the priority was arrived at, every
 * execution attempt with its request and response, the experiment measuring whether it worked,
 * and the change-log entries it produced. If a section has no data it says what would populate
 * it instead of rendering an empty panel.
 */

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function when(value: Date | null | undefined): string {
  return value ? DATE_TIME.format(value) : '—';
}

export interface ActionAgentRun {
  id: string;
  agent: string;
  status: string;
  trigger: string;
  summary: string | null;
  model: string | null;
  costUsd: number | null;
  actionsCreated: number;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface ActionDetailViewProps {
  action: ActionDetail;
  guardrail: ActionGuardrail;
  /** Null when a rollback is possible; otherwise exactly why it is not. */
  rollbackBlockedReason: string | null;
  /** The most recent run of the proposing agent before this action appeared, if there was one. */
  agentRun: ActionAgentRun | null;
}

export function ActionDetailView({
  action,
  guardrail,
  rollbackBlockedReason,
  agentRun,
}: ActionDetailViewProps): React.JSX.Element {
  const score = actionPriority(action);
  const approved = action.status === 'APPROVED' || action.approvedAt !== null;

  return (
    <div className="space-y-5 px-4 py-6 md:px-6">
      <PageHeader
        breadcrumb={
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <Link href="/actions" className="underline-offset-4 hover:text-foreground hover:underline">
              AI actions
            </Link>
            <span aria-hidden="true"> / </span>
            <span className="text-foreground">{humanizeStatus(action.type)}</span>
          </nav>
        }
        title={action.title}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              href={`/sites/${action.websiteId}`}
              className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
            >
              <Globe className="size-3.5" aria-hidden="true" />
              {action.website.name}
            </Link>
            <span aria-hidden="true">·</span>
            <Badge variant="outline">{humanizeStatus(action.type)}</Badge>
            <StatusBadge status={action.status} />
            <RiskBadge risk={action.risk} />
            {action.autoExecutable ? (
              <Badge variant="success">
                <ShieldCheck className="size-3" aria-hidden="true" />
                Auto-executable
              </Badge>
            ) : (
              <Badge variant="muted">Needs approval</Badge>
            )}
            <span aria-hidden="true">·</span>
            <span>Proposed {when(action.proposedAt)}</span>
          </span>
        }
        actions={
          <ActionControls
            actionId={action.id}
            status={action.status}
            approved={approved}
            guardrail={{
              allowed: guardrail.allowed,
              reason: guardrail.reason,
              requiresApproval: guardrail.requiresApproval,
            }}
            rollbackBlockedReason={rollbackBlockedReason}
          />
        }
      />

      {action.error ? (
        <Alert variant="destructive">
          <AlertTitle>The last attempt failed</AlertTitle>
          <AlertDescription>{action.error}</AlertDescription>
        </Alert>
      ) : null}

      {!guardrail.allowed && !approved ? (
        <Alert variant="warning">
          <AlertTitle>This change needs your approval before it can run</AlertTitle>
          <AlertDescription>{guardrail.reason}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" aria-hidden="true" />
                Reasoning
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">{action.reasoning}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileSearch className="size-4" aria-hidden="true" />
                Evidence
                <TooltipInfo
                  label="About the evidence"
                  content="The data the agent based this proposal on, exactly as it recorded it. Nothing here is recomputed for display."
                />
              </CardTitle>
            </CardHeader>
            <CardContent>
              {hasJsonContent(action.evidence) ? (
                <JsonView value={action.evidence} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  This action was created without structured evidence. The reasoning above is all
                  the agent recorded.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="size-4" aria-hidden="true" />
                Affected URLs
                <span className="tabular text-xs font-normal text-muted-foreground">
                  ({formatNumber(action.affectedUrls.length)})
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {action.affectedUrls.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No URLs were recorded on this action. Site-wide changes and content briefs do not
                  target a specific page.
                </p>
              ) : (
                <ul className="space-y-1">
                  {action.affectedUrls.map((url) => (
                    <li key={url} className="rounded-md px-1 py-0.5 hover:bg-accent">
                      <UrlCell url={url} maxLength={72} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <ExecutionHistory executions={action.executions} status={action.status} />

          <ExperimentCard experiment={action.experiment} status={action.status} measureAfter={action.measureAfter} />

          <ChangeLogCard entries={action.changeLogs} />
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Priority</CardTitle>
            </CardHeader>
            <CardContent>
              <ScoreBreakdown score={score} title="Priority score" ringSize="lg" />
              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3">
                <PriorityInput label="Impact" value={formatPercent(action.impactScore, 0)} />
                <PriorityInput label="Confidence" value={formatPercent(action.confidenceScore, 0)} />
                <PriorityInput label="Business value" value={formatPercent(action.businessValue, 0)} />
                <PriorityInput label="Effort" value={`${action.effortScore} / 5`} />
                <PriorityInput label="Risk" value={`${action.riskScore} / 5`} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4" aria-hidden="true" />
                Automation guardrail
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p
                className={cn(
                  'rounded-md border px-2.5 py-2 text-xs leading-relaxed',
                  guardrail.allowed
                    ? 'border-success/25 bg-success/[0.07] text-foreground'
                    : 'border-warning/25 bg-warning/[0.07] text-foreground',
                )}
              >
                {guardrail.reason}
              </p>
              <StatList dense divided>
                <StatListItem label="Risk band" value={guardrail.risk} />
                <StatListItem
                  label="Autonomy level"
                  value={humanizeStatus(action.website.settings?.autonomyLevel ?? 'L1_DRAFTS_ONLY')}
                />
                <StatListItem
                  label="Auto-approve safe"
                  value={action.website.settings?.autoApproveSafe ? 'On' : 'Off'}
                />
                <StatListItem label="Source" value={action.sourceType ?? 'Not recorded'} />
              </StatList>
              <p className="text-2xs leading-relaxed text-muted-foreground">
                Change these on the site&apos;s{' '}
                <Link
                  href={`/sites/${action.websiteId}/settings`}
                  className="font-medium underline underline-offset-4"
                >
                  automation settings
                </Link>
                .
              </p>
            </CardContent>
          </Card>

          <AgentCard requiredAgent={action.requiredAgent} run={agentRun} websiteId={action.websiteId} />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="size-4" aria-hidden="true" />
                Timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              <StatList dense divided>
                <StatListItem label="Proposed" value={when(action.proposedAt)} />
                <StatListItem label="Approved" value={when(action.approvedAt)} muted={!action.approvedAt} />
                <StatListItem label="Executed" value={when(action.executedAt)} muted={!action.executedAt} />
                <StatListItem label="Completed" value={when(action.completedAt)} muted={!action.completedAt} />
                <StatListItem
                  label="Measure after"
                  value={when(action.measureAfter)}
                  muted={!action.measureAfter}
                  hint="The date the experiment can first be evaluated — search results need time to settle."
                />
                <StatListItem label="Action ID" value={action.id} mono copyValue={action.id} />
              </StatList>
            </CardContent>
          </Card>

          <ApprovalsCard approvals={action.approvals} />
        </div>
      </div>
    </div>
  );
}

/** One priority input, shown beside the weighted breakdown so the raw numbers are visible too. */
function PriorityInput({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-2xs text-muted-foreground">{label}</dt>
      <dd className="tabular text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function ExecutionHistory({
  executions,
  status,
}: {
  executions: ActionDetail['executions'];
  status: string;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-4" aria-hidden="true" />
          Execution history
          {executions.length > 0 ? (
            <span className="tabular text-xs font-normal text-muted-foreground">({executions.length})</span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {executions.length === 0 ? (
          <EmptyState
            size="sm"
            icon={Activity}
            title="This action has never run"
            description={
              status === 'REJECTED'
                ? 'It was rejected before it reached the queue.'
                : 'Approve it and press Execute — every attempt is recorded here with the request sent to the CMS, the response, and the before and after state.'
            }
          />
        ) : (
          <ol className="space-y-3">
            {executions.map((execution) => (
              <li key={execution.id} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    <span className="tabular text-xs font-medium text-foreground">
                      Attempt {execution.attempt}
                    </span>
                    <StatusBadge status={execution.status} />
                    {execution.adapter ? <Badge variant="outline">{execution.adapter}</Badge> : null}
                  </span>
                  <span className="tabular text-2xs text-muted-foreground">
                    {when(execution.startedAt)}
                    {execution.durationMs !== null ? ` · ${formatNumber(execution.durationMs)} ms` : ''}
                  </span>
                </div>

                {execution.error ? (
                  <p className="mt-2 rounded-md border border-destructive/25 bg-destructive/[0.07] px-2 py-1.5 text-2xs leading-relaxed text-foreground">
                    {execution.error}
                  </p>
                ) : null}

                <div className="mt-2 grid gap-2 md:grid-cols-2">
                  <JsonPanel label="Request" value={execution.request} />
                  <JsonPanel label="Response" value={execution.response} />
                  <JsonPanel label="Before" value={execution.beforeState} />
                  <JsonPanel label="After" value={execution.afterState} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function JsonPanel({ label, value }: { label: string; value: unknown }): React.JSX.Element | null {
  if (!hasJsonContent(value)) return null;
  return (
    <details className="rounded-md border border-border bg-background/60 px-2.5 py-2">
      <summary className="cursor-pointer text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <JsonView value={value} depth={1} />
      </div>
    </details>
  );
}

const OUTCOME_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'muted'> = {
  LIKELY_POSITIVE: 'success',
  INCONCLUSIVE: 'warning',
  LIKELY_NEGATIVE: 'destructive',
  PENDING: 'muted',
};

function ExperimentCard({
  experiment,
  status,
  measureAfter,
}: {
  experiment: ActionDetail['experiment'];
  status: string;
  measureAfter: Date | null;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="size-4" aria-hidden="true" />
          Measured outcome
          <TooltipInfo
            label="About measurement"
            content="Every applied change becomes an experiment: the metric is compared against the baseline window once enough days of Search Console data have accumulated."
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!experiment ? (
          <EmptyState
            size="sm"
            icon={FlaskConical}
            title="Nothing measured yet"
            description={
              status === 'COMPLETED' || status === 'MEASURING'
                ? `Measurement starts once the change has been live long enough${measureAfter ? ` — from ${when(measureAfter)}` : ''}. Search Console data lags by about three days.`
                : 'An experiment is created when this action is applied to the live site, so its effect on clicks and position can be measured against the weeks before.'
            }
          />
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{experiment.name}</span>
              <StatusBadge status={experiment.status} />
              <Badge variant={OUTCOME_VARIANT[experiment.outcome] ?? 'muted'}>
                {humanizeStatus(experiment.outcome)}
              </Badge>
            </div>

            {experiment.hypothesis ? (
              <p className="text-xs leading-relaxed text-muted-foreground">{experiment.hypothesis}</p>
            ) : null}

            <StatList dense divided>
              <StatListItem label="Metric" value={experiment.metric} />
              <StatListItem
                label="Change"
                value={experiment.deltaPct === null ? 'Not evaluated' : formatDelta(experiment.deltaPct, 1)}
                muted={experiment.deltaPct === null}
              />
              <StatListItem
                label="Significance"
                value={experiment.significance === null ? 'Not evaluated' : `p = ${experiment.significance.toFixed(3)}`}
                muted={experiment.significance === null}
                hint="Welch's t-test over the daily metric. Below 0.05 the change is unlikely to be noise."
              />
              <StatListItem
                label="Baseline window"
                value={`${when(experiment.baselineStart)} → ${when(experiment.baselineEnd)}`}
              />
              <StatListItem
                label="Measurement window"
                value={`${when(experiment.measureStart)} → ${experiment.measureEnd ? when(experiment.measureEnd) : 'ongoing'}`}
              />
              <StatListItem label="Evaluated" value={when(experiment.evaluatedAt)} muted={!experiment.evaluatedAt} />
            </StatList>

            {experiment.interpretation ? (
              <p className="rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs leading-relaxed text-foreground">
                {experiment.interpretation}
              </p>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ChangeLogCard({ entries }: { entries: ActionDetail['changeLogs'] }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" aria-hidden="true" />
          Change log
        </CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No change-log entries yet. One is written for every value this action writes to the live
            site, and again if it is rolled back.
          </p>
        ) : (
          <ol className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.id} className="border-l-2 border-border pl-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{humanizeStatus(entry.changeType)}</Badge>
                  <span className="text-xs font-medium text-foreground">{entry.actor}</span>
                  {entry.agent ? <span className="text-2xs text-muted-foreground">via {entry.agent}</span> : null}
                  {entry.rolledBackAt ? <Badge variant="warning">Reverted</Badge> : null}
                  <span className="tabular ml-auto text-2xs text-muted-foreground">{when(entry.createdAt)}</span>
                </div>
                <p className="mt-0.5 text-xs leading-relaxed text-foreground">{entry.summary}</p>
                {entry.reason ? (
                  <p className="mt-0.5 text-2xs leading-relaxed text-muted-foreground">{entry.reason}</p>
                ) : null}
                {entry.targetUrl ? (
                  <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground">{entry.targetUrl}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function AgentCard({
  requiredAgent,
  run,
  websiteId,
}: {
  requiredAgent: string | null;
  run: ActionAgentRun | null;
  websiteId: string;
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" aria-hidden="true" />
          Proposing agent
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {requiredAgent ? (
          <p className="text-sm font-medium text-foreground">{requiredAgent}</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No agent is recorded on this action — it was created directly rather than by an agent run.
          </p>
        )}

        {run ? (
          <>
            <StatList dense divided>
              <StatListItem label="Run status" value={<StatusBadge status={run.status} />} />
              <StatListItem label="Trigger" value={humanizeStatus(run.trigger)} />
              <StatListItem label="Started" value={when(run.startedAt)} />
              <StatListItem label="Finished" value={when(run.finishedAt)} muted={!run.finishedAt} />
              <StatListItem label="Model" value={run.model ?? 'Not recorded'} muted={!run.model} />
              <StatListItem
                label="Run cost"
                value={run.costUsd === null ? 'Not recorded' : formatUsd(run.costUsd)}
                muted={run.costUsd === null}
              />
              <StatListItem
                label="Actions created"
                value={formatNumber(run.actionsCreated)}
                hint="How many proposals that whole run produced, this one included."
              />
            </StatList>
            {run.summary ? (
              <p className="text-2xs leading-relaxed text-muted-foreground">{run.summary}</p>
            ) : null}
            <p className="text-2xs text-muted-foreground">
              This is the most recent run of that agent before the action appeared — runs are not
              linked to individual proposals in the database, so it is the closest attribution
              available.
            </p>
            <Link
              href={`/sites/${websiteId}/strategy`}
              className="inline-block text-xs font-medium text-primary underline-offset-4 hover:underline"
            >
              Open the AI SEO Manager
            </Link>
          </>
        ) : requiredAgent ? (
          <p className="text-xs text-muted-foreground">
            No run of this agent is on record for this site before the action was proposed.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ApprovalsCard({ approvals }: { approvals: ActionDetail['approvals'] }): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckSquare className="size-4" aria-hidden="true" />
          Approvals
        </CardTitle>
      </CardHeader>
      <CardContent>
        {approvals.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No approval has ever been raised for this action.
          </p>
        ) : (
          <ul className="space-y-2">
            {approvals.map((approval) => (
              <li key={approval.id} className="rounded-md border border-border p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={approval.status} />
                  <RiskBadge risk={approval.risk} />
                  <span className="tabular ml-auto text-2xs text-muted-foreground">
                    {when(approval.decidedAt ?? approval.createdAt)}
                  </span>
                </div>
                {approval.decisionNote ? (
                  <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                    “{approval.decisionNote}”
                  </p>
                ) : null}
                {approval.status === 'PENDING' ? (
                  <Link
                    href={`/approvals?focus=${approval.id}`}
                    className="mt-1 inline-block text-2xs font-medium text-primary underline-offset-4 hover:underline"
                  >
                    Review the diff and decide
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
