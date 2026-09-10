import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { History, ListChecks, ShieldCheck } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { getCurrentUser } from '@/lib/auth';
import { getAutomationsData } from '@/components/automations/queries';
import { AutonomySelector } from '@/components/automations/autonomy-selector';
import { ScheduleList } from '@/components/automations/schedule-list';
import { AgentList } from './agent-list';
import { AiBudgetCard } from './ai-budget-card';

export const metadata: Metadata = { title: 'Automations' };
export const dynamic = 'force-dynamic';

/**
 * Automations for one site: how much the platform may do on its own, what it does on a timer,
 * which agents are registered, and what it is allowed to spend doing it.
 *
 * The four blocks are deliberately on one screen. Autonomy without the schedule that triggers it
 * — or without the budget that stops it — is only half the answer to "what will this thing do
 * tonight while I am asleep".
 */
export default async function AutomationsPage({
  params,
}: {
  params: Promise<{ websiteId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const { websiteId } = await params;

  let data;
  try {
    data = await getAutomationsData(user.id, websiteId);
  } catch {
    notFound();
  }

  const { website, automation, schedules, agents, spend, environment } = data;
  const paused = website.status !== 'ACTIVE';

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Automations"
        description={
          <>
            What runs on its own for {website.name}, and what waits for you. Every automatic change
            is recorded in{' '}
            <Link
              href={`/sites/${website.id}/history`}
              className="font-medium text-foreground underline-offset-4 hover:underline"
            >
              History
            </Link>
            .
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/sites/${website.id}/history`}>
                <History aria-hidden="true" className="mr-1.5 size-3.5" />
                History
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/approvals">
                <ShieldCheck aria-hidden="true" className="mr-1.5 size-3.5" />
                Approvals
              </Link>
            </Button>
          </div>
        }
      />

      {paused ? (
        <Alert variant="warning" icon={ListChecks}>
          <AlertTitle>
            This site is {website.status.toLowerCase()}, so no schedule will fire
          </AlertTitle>
          <AlertDescription>
            Repeatable jobs are only registered for active sites. The schedules below are kept
            exactly as you set them and resume when you set the site back to Active in{' '}
            <Link
              href={`/sites/${website.id}/settings`}
              className="font-medium underline underline-offset-4"
            >
              Settings → General
            </Link>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <div className="space-y-6">
          <AutonomySelector
            websiteId={website.id}
            autonomyLevel={automation.autonomyLevel}
            autoApproveSafe={automation.autoApproveSafe}
          />

          <ScheduleList
            websiteId={website.id}
            schedules={schedules}
            queueConfigured={environment.queueConfigured}
          />
        </div>

        <AiBudgetCard
          websiteId={website.id}
          monthlyBudgetUsd={automation.monthlyAiBudgetUsd}
          monthToDateUsd={spend.monthToDateUsd}
          calls={spend.calls}
          periodStart={spend.periodStart.toISOString()}
          aiConfigured={environment.aiConfigured}
        />
      </div>

      <AgentList
        websiteId={website.id}
        agents={agents}
        aiConfigured={environment.aiConfigured}
        queueConfigured={environment.queueConfigured}
      />
    </div>
  );
}
