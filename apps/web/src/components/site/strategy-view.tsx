'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle, Bot, CalendarDays, CalendarRange, CheckCircle2, HelpCircle, Loader2,
  MinusCircle, Sparkles, Target, TrendingDown, TrendingUp, XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { ScoreBreakdown } from '@/components/ui/score-breakdown';
import { TooltipInfo } from '@/components/ui/tooltip-info';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { apiPost, ApiError } from '@/lib/api-client';
import { cn, formatUsd, shortenUrl } from '@/lib/utils';
import type { ScoreFactor } from '@seo/shared';
import type { PlanItem, StrategyData } from '@/server/queries/strategy';

const OUTCOME_STYLE = {
  LIKELY_POSITIVE: { icon: TrendingUp, label: 'Likely positive', className: 'text-success' },
  LIKELY_NEGATIVE: { icon: TrendingDown, label: 'Likely negative', className: 'text-destructive' },
  INCONCLUSIVE: { icon: MinusCircle, label: 'Inconclusive', className: 'text-muted-foreground' },
  PENDING: { icon: Loader2, label: 'Measuring', className: 'text-muted-foreground' },
} as const;

export function StrategyView({ data }: { data: StrategyData }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const { website, plan, actions, experiments, agentRuns, outcomeSummary } = data;

  const runManager = async () => {
    setRunning(true);
    try {
      const result = await apiPost<{ enqueued?: boolean; reason?: string }>(
        `/api/agents/SEOManagerAgent/run`,
        { websiteId: website.id },
      );
      if (result.enqueued === false) {
        toast.warning('Queued, but no worker is connected', {
          description: 'Start the worker (npm run dev:worker) or check REDIS_URL.',
        });
      } else {
        toast.success('AI SEO Manager is running', {
          description: 'It gathers the site data, reasons over it, then writes a plan. Refresh in a moment.',
        });
      }
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not start the agent');
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="AI SEO Manager"
        description={
          plan
            ? `Plan generated ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(plan.createdAt)}`
            : 'No plan yet for this site.'
        }
        actions={
          <Button onClick={() => void runManager()} disabled={running}>
            {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Bot className="mr-2 h-4 w-4" />}
            {plan ? 'Regenerate plan' : 'Generate plan'}
          </Button>
        }
      />

      {!plan ? (
        <EmptyState
          bordered
          icon={Bot}
          title="No strategy yet"
          description="The AI SEO Manager reads this site's performance, technical issues, opportunities, competitor gaps, GEO score and the measured results of past actions, then decides what to do next — and why."
          action={
            <Button onClick={() => void runManager()} disabled={running}>
              {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
              Generate the first plan
            </Button>
          }
        />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Situation
                <Badge variant="outline" className="ml-auto text-2xs font-normal">
                  {Math.round(plan.confidence * 100)}% confidence
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-relaxed">{plan.situation}</p>

              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-primary">
                  Recommended strategy
                </p>
                <p className="text-sm leading-relaxed">{plan.strategy}</p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <ListBlock
                  title="Biggest problems"
                  icon={AlertTriangle}
                  tone="destructive"
                  items={plan.biggestProblems}
                  emptyText="No blocking problems identified."
                />
                <ListBlock
                  title="Biggest opportunities"
                  icon={Target}
                  tone="success"
                  items={plan.biggestOpportunities}
                  emptyText="No standout opportunities identified."
                />
              </div>

              {plan.observedResults.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/30 p-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3" />
                    What we learned from past actions on this site
                  </p>
                  <ul className="space-y-1">
                    {plan.observedResults.map((result, index) => (
                      <li key={index} className="text-xs leading-relaxed text-muted-foreground">
                        {result}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <PlanColumn title="Today" icon={CalendarDays} items={plan.today} websiteId={website.id} />
            <PlanColumn title="This week" icon={CalendarRange} items={plan.thisWeek} websiteId={website.id} />
            <PlanColumn title="This month" icon={CalendarRange} items={plan.thisMonth} websiteId={website.id} />
          </div>
        </>
      )}

      <Tabs defaultValue="actions">
        <TabsList>
          <TabsTrigger value="actions">Action queue ({actions.length})</TabsTrigger>
          <TabsTrigger value="results">Observed results ({experiments.length})</TabsTrigger>
          <TabsTrigger value="runs">Agent runs ({agentRuns.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="actions" className="mt-4">
          {actions.length === 0 ? (
            <EmptyState size="sm" title="No open actions" description="Generate a plan to populate the queue." />
          ) : (
            <div className="space-y-2">
              {actions.map((action, index) => (
                <ActionRow key={action.id} action={action} rank={index + 1} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="results" className="mt-4 space-y-4">
          {outcomeSummary.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  What actually works on this site
                  <TooltipInfo content="Rolled up from measured experiments. These learnings adjust the priority score of similar future proposals, which is how the platform stops repeating what does not work here." />
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2">
                  {outcomeSummary.map((summary) => (
                    <li key={summary.actionType} className="flex items-start gap-2 text-xs">
                      <Badge variant="outline" className="shrink-0 text-2xs">
                        {summary.actionType.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      <span className="text-muted-foreground">{summary.learning}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          {experiments.length === 0 ? (
            <EmptyState
              size="sm"
              title="Nothing measured yet"
              description="Every applied change opens an experiment. Results appear here after the measurement window closes."
            />
          ) : (
            <div className="space-y-2">
              {experiments.map((experiment) => {
                const style = OUTCOME_STYLE[experiment.outcome] ?? OUTCOME_STYLE.PENDING;
                return (
                  <Card key={experiment.id}>
                    <CardContent className="flex items-start gap-3 p-4">
                      <style.icon className={cn('mt-0.5 h-4 w-4 shrink-0', style.className)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-medium">{experiment.name}</p>
                          <Badge variant="outline" className="text-2xs">{style.label}</Badge>
                          {experiment.deltaPct !== null && (
                            <span
                              className={cn(
                                'tabular text-xs font-semibold',
                                experiment.deltaPct > 0 ? 'text-success' : experiment.deltaPct < 0 ? 'text-destructive' : '',
                              )}
                            >
                              {experiment.deltaPct > 0 ? '+' : ''}
                              {experiment.deltaPct.toFixed(1)}%
                            </span>
                          )}
                        </div>
                        {experiment.changeSummary && (
                          <p className="mt-0.5 text-xs text-muted-foreground">{experiment.changeSummary}</p>
                        )}
                        {experiment.interpretation && (
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {experiment.interpretation}
                          </p>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          {agentRuns.length === 0 ? (
            <EmptyState size="sm" title="No agent runs yet" />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Agent</th>
                    <th scope="col" className="px-3 py-2 font-medium">Status</th>
                    <th scope="col" className="px-3 py-2 font-medium">Summary</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Cost</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">When</th>
                  </tr>
                </thead>
                <tbody>
                  {agentRuns.map((run) => (
                    <tr key={run.id} className="data-grid-row">
                      <td className="px-3 py-2 font-medium">{run.agent}</td>
                      <td className="px-3 py-2">
                        <Badge
                          variant={
                            run.status === 'COMPLETED' ? 'success' : run.status === 'FAILED' ? 'destructive' : 'secondary'
                          }
                          className="text-2xs"
                        >
                          {run.status.toLowerCase()}
                        </Badge>
                      </td>
                      <td className="max-w-[380px] px-3 py-2">
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {run.error ?? run.summary ?? '—'}
                        </span>
                      </td>
                      <td className="tabular px-3 py-2 text-right">{run.actionsCreated}</td>
                      <td className="tabular px-3 py-2 text-right text-muted-foreground">
                        {run.costUsd ? formatUsd(run.costUsd) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right text-xs text-muted-foreground">
                        {new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeStyle: 'short' }).format(run.startedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ListBlock({
  title,
  icon: Icon,
  tone,
  items,
  emptyText,
}: {
  title: string;
  icon: typeof AlertTriangle;
  tone: 'destructive' | 'success';
  items: string[];
  emptyText: string;
}) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className={cn('h-3 w-3', tone === 'destructive' ? 'text-destructive' : 'text-success')} />
        {title}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li key={index} className="flex gap-1.5 text-xs leading-relaxed">
              <span className="text-muted-foreground">·</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanColumn({
  title,
  icon: Icon,
  items,
  websiteId,
}: {
  title: string;
  icon: typeof CalendarDays;
  items: PlanItem[];
  websiteId: string;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
          <span className="tabular ml-auto text-xs font-normal text-muted-foreground">{items.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing scheduled.</p>
        ) : (
          <ol className="space-y-2.5">
            {items.map((item, index) => {
              const body = (
                <>
                  <p className="text-sm font-medium leading-snug">{item.title}</p>
                  {item.reason && (
                    <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.reason}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    {item.impact && <Badge variant="outline" className="text-2xs">Impact: {item.impact}</Badge>}
                    {item.effort && <Badge variant="outline" className="text-2xs">Effort: {item.effort}</Badge>}
                  </div>
                </>
              );
              return (
                <li key={index} className="flex gap-2.5">
                  <span className="tabular mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-2xs font-semibold">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {item.actionId ? (
                      <Link href={`/actions/${item.actionId}`} className="block hover:text-primary">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function ActionRow({ action, rank }: { action: StrategyData['actions'][number]; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const factors = Array.isArray(action.priorityFactors)
    ? (action.priorityFactors as unknown as ScoreFactor[])
    : ((action.priorityFactors as { factors?: ScoreFactor[] } | null)?.factors ?? []);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          <span className="tabular mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold">
            {rank}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/actions/${action.id}`} className="text-sm font-medium hover:text-primary">
                {action.title}
              </Link>
              <Badge variant="outline" className="text-2xs">
                {action.type.replace(/_/g, ' ').toLowerCase()}
              </Badge>
              <Badge
                variant={action.risk === 'HIGH' ? 'destructive' : action.risk === 'MEDIUM' ? 'warning' : 'success'}
                className="text-2xs"
              >
                {action.risk.toLowerCase()}
              </Badge>
              {action.autoExecutable ? (
                <Badge variant="secondary" className="text-2xs">Auto-executable</Badge>
              ) : (
                <Badge variant="secondary" className="text-2xs">Needs approval</Badge>
              )}
            </div>

            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{action.reasoning}</p>

            {action.affectedUrls.length > 0 && (
              <p className="mt-1 truncate font-mono text-2xs text-muted-foreground">
                {action.affectedUrls.slice(0, 2).map((url) => shortenUrl(url, 40)).join(', ')}
                {action.affectedUrls.length > 2 && ` +${action.affectedUrls.length - 2} more`}
              </p>
            )}

            {expanded && factors.length > 0 && (
              <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
                <ScoreBreakdown
                  score={{
                    score: action.priorityScore,
                    factors,
                    summary: `Impact ${Math.round(action.impactScore * 100)}% × confidence ${Math.round(action.confidenceScore * 100)}% × business value ${Math.round(action.businessValue * 100)}% ÷ (effort ${action.effortScore} × risk ${action.riskScore}).`,
                  }}
                  title="Why this priority"
                />
              </div>
            )}
          </div>

          <div className="shrink-0 text-right">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-right"
              aria-expanded={expanded}
            >
              <span className="tabular text-lg font-semibold">{Math.round(action.priorityScore)}</span>
              <HelpCircle className="h-3 w-3 text-muted-foreground" />
            </button>
            <p className="text-2xs text-muted-foreground">priority</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
