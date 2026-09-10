'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, KeyRound, Play } from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { ApiError, apiPost } from '@/lib/api-client';
import { formatNumber, formatUsd } from '@/lib/utils';
import type { AutomationsData } from '@/components/automations/queries';

/**
 * The registered agents for this site: what each one does, when it last ran, and a way to run
 * it now.
 *
 * Everything on a row is recorded fact — the last `AgentRun` row and the count of runs. An agent
 * that has never run here says so rather than showing a plausible-looking zero, because "never
 * run" and "ran and found nothing" are different problems with different fixes.
 */

type Agent = AutomationsData['agents'][number];

const DATE_TIME = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const CATEGORY_LABEL: Record<Agent['category'], string> = {
  technical: 'Technical',
  content: 'Content',
  keywords: 'Keywords',
  geo: 'GEO',
  strategy: 'Strategy',
};

/** `123456` → `2m 3s`; short runs stay in seconds so the number is comparable at a glance. */
function duration(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface AgentListProps {
  websiteId: string;
  agents: readonly Agent[];
  aiConfigured: boolean;
  queueConfigured: boolean;
}

export function AgentList({
  websiteId,
  agents,
  aiConfigured,
  queueConfigured,
}: AgentListProps): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (agent: Agent) => {
      setBusy(agent.key);
      try {
        const result = await apiPost<{ enqueued?: boolean; message?: string }>(
          `/api/websites/${websiteId}/automations`,
          { op: 'run-agent', agent: agent.key },
        );
        if (result.enqueued === false) {
          toast.warning(`${agent.label} was recorded but not started`, {
            description:
              result.message ??
              'No queue broker is reachable. Set REDIS_URL and start the worker, then retry from the Jobs screen.',
          });
        } else {
          toast.success(`${agent.label} queued`, {
            description: 'Follow it on the Jobs screen; anything it proposes lands in Approvals.',
          });
        }
        router.refresh();
      } catch (cause) {
        toast.error(
          cause instanceof ApiError ? cause.message : `Could not start ${agent.label}.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [router, websiteId],
  );

  const blockedCount = agents.filter((agent) => agent.blockedByMissingAi).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot aria-hidden="true" className="size-4 text-primary" />
          Agents
        </CardTitle>
        <CardDescription>
          The agents registered for this installation. Running one queues a job; what it proposes
          still obeys the autonomy level above.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-3">
        {!aiConfigured && blockedCount > 0 ? (
          <Alert variant="warning" icon={KeyRound}>
            <AlertTitle>
              {blockedCount} agent{blockedCount === 1 ? '' : 's'} cannot run without a language model
            </AlertTitle>
            <AlertDescription>
              Set <code className="font-mono text-2xs">ANTHROPIC_API_KEY</code>,{' '}
              <code className="font-mono text-2xs">OPENAI_API_KEY</code> or{' '}
              <code className="font-mono text-2xs">GOOGLE_AI_API_KEY</code> on the server. The
              agents that read crawl and Search Console data only are unaffected.
            </AlertDescription>
          </Alert>
        ) : null}

        <ul className="divide-y divide-border">
          {agents.map((agent) => {
            const running = busy === agent.key;
            const last = agent.lastRun;
            const ran = duration(last?.durationMs ?? null);

            return (
              <li
                key={agent.key}
                className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{agent.label}</h3>
                    <Badge variant="muted" className="text-2xs font-normal">
                      {CATEGORY_LABEL[agent.category]}
                    </Badge>
                    {agent.requiresAi ? (
                      <SimpleTooltip content="This agent calls a language model, so it needs a provider key and it draws on the AI budget.">
                        <Badge variant="outline" className="text-2xs font-normal">
                          Uses AI
                        </Badge>
                      </SimpleTooltip>
                    ) : null}
                    {last ? <StatusBadge status={last.status} /> : null}
                  </div>

                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    {agent.description}
                  </p>

                  <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
                    {last ? (
                      <>
                        <span>Last run {DATE_TIME.format(new Date(last.startedAt))}</span>
                        {ran ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>took {ran}</span>
                          </>
                        ) : null}
                        <span aria-hidden="true">·</span>
                        <span>
                          {formatNumber(last.actionsCreated)} action
                          {last.actionsCreated === 1 ? '' : 's'} created
                        </span>
                        {last.costUsd !== null && last.costUsd > 0 ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{formatUsd(last.costUsd)}</span>
                          </>
                        ) : null}
                        <span aria-hidden="true">·</span>
                        <span>
                          {formatNumber(agent.runCount)} run{agent.runCount === 1 ? '' : 's'} here
                        </span>
                      </>
                    ) : (
                      <span>Never run for this site.</span>
                    )}
                  </p>

                  {last?.summary ? (
                    <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
                      {last.summary}
                    </p>
                  ) : null}

                  {last?.error ? (
                    <p className="mt-1 break-words text-2xs leading-relaxed text-destructive">
                      Last error: {last.error}
                    </p>
                  ) : null}
                </div>

                <div className="shrink-0">
                  {agent.blockedByMissingAi ? (
                    <SimpleTooltip content="No AI provider key is set on this installation, so this agent has nothing to call.">
                      {/* A disabled button is not focusable, so the span carries the tooltip. */}
                      <span className="inline-flex">
                        <Button variant="outline" size="sm" className="h-8" disabled>
                          <Play aria-hidden="true" />
                          Run now
                        </Button>
                      </span>
                    </SimpleTooltip>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8"
                      loading={running}
                      loadingText="Queueing"
                      onClick={() => void run(agent)}
                    >
                      <Play aria-hidden="true" />
                      Run now
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        {!queueConfigured ? (
          <p className="text-2xs text-muted-foreground">
            No queue broker is connected, so &ldquo;Run now&rdquo; records the job without a worker
            to execute it. Set <code className="font-mono">REDIS_URL</code> and start the worker.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
