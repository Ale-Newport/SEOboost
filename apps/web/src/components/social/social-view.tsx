'use client';

import { useCallback, useState } from 'react';
import { CalendarCheck, Compass, Hand, Inbox, Megaphone, Radar, Send, ShieldCheck, Sparkles } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/metric-card';
import { PageHeader } from '@/components/ui/page-header';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatNumber } from '@/lib/utils';
import { AccountsTab } from './accounts-tab';
import { ComposeDialog, type ComposeContext, type ComposeTarget } from './compose-dialog';
import { relativeTime } from './format';
import { InboxTab } from './inbox-tab';
import { PostsTab } from './posts-tab';
import { RunAgentButton } from './run-agent-button';
import { SettingsTab } from './settings-tab';
import { TopicsTab } from './topics-tab';
import { SOCIAL_TABS, type SocialOverview, type SocialTab } from './types';

/**
 * Social — finding the conversations where this site is a genuine answer, taking part in them
 * as a disclosed maker, and keeping the site's own channels active.
 *
 * The screen is organised around what the operator does next: an inbox of threads to read, a
 * queue of posts to approve or post by hand, the topics and communities that feed the inbox,
 * the accounts posts go out from, and the limits that bound all of it. The active tab lives in
 * `?tab=` (updated with `replaceState`, so switching tabs never throws away a half-typed form).
 */

const TAB_LABEL: Record<SocialTab, string> = {
  inbox: 'Inbox',
  posts: 'Posts',
  topics: 'Topics & communities',
  accounts: 'Accounts',
  settings: 'Limits & automation',
};

const RUN_STATUS_VARIANT: Record<string, 'success' | 'destructive' | 'info' | 'muted'> = {
  COMPLETED: 'success',
  FAILED: 'destructive',
  RUNNING: 'info',
  CANCELLED: 'muted',
};

export function SocialView({ data, initialTab }: { data: SocialOverview; initialTab: SocialTab }): React.JSX.Element {
  const [tab, setTab] = useState<SocialTab>(initialTab);
  const [compose, setCompose] = useState<ComposeTarget | null>(null);
  const { website, counts, aiConfigured, agentReach } = data;

  const changeTab = useCallback((value: string) => {
    const next = SOCIAL_TABS.find((entry) => entry === value);
    if (!next) return;
    setTab(next);
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (next === 'inbox') url.searchParams.delete('tab');
    else url.searchParams.set('tab', next);
    window.history.replaceState(null, '', url.toString());
  }, []);

  const activeTopics = data.topics.filter((topic) => topic.isActive).length;
  const connectedPosting = data.accounts.filter(
    (account) => account.status === 'CONNECTED' && account.canPost && data.publishers.some((p) => p.platform === account.platform && p.capabilities.original),
  ).length;
  const brandName = website.brandName ?? website.name;

  const composeContext: ComposeContext = {
    websiteId: website.id,
    accounts: data.accounts,
    textRules: data.textRules,
    brandTerms: website.brandTerms,
    brandName,
    disclosure: data.settings.socialDisclosure,
    // Hacker News is the hand-posted platform worth offering for new posts ("Show HN").
    manualPlatforms: data.manualOnlyPlatforms.filter((platform) => platform === 'HACKER_NEWS'),
  };

  const noAi = 'No AI provider is configured on this installation (set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY).';

  return (
    <div className="space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title="Social"
        description={`Find the conversations where ${brandName} genuinely helps, answer them as yourself with disclosure, and keep your own channels posting — within caps that keep it from ever reading as spam.`}
      />

      {/* Its own wrapping row rather than PageHeader actions: four buttons do not fit beside the
          title on a phone, and the header's action slot does not wrap below its content width. */}
      <div className="-mt-4 flex flex-wrap items-center gap-2" role="toolbar" aria-label="Run social agents">
        <RunAgentButton
          websiteId={website.id}
          agent="social-listening"
          label="Run listening"
          queuedTitle="Listening queued — new threads land in the inbox"
          icon={Radar}
          blockedReason={null}
        />
        <RunAgentButton
          websiteId={website.id}
          agent="social-engagement"
          label="Draft replies"
          queuedTitle="Drafting replies — they will wait in Approvals"
          icon={Sparkles}
          blockedReason={
            !aiConfigured
              ? noAi
              : counts.shortlisted + counts.newConversations === 0
                ? 'No open conversations to answer yet. Run listening first.'
                : null
          }
        />
        <RunAgentButton
          websiteId={website.id}
          agent="social-content"
          label="Plan today's posts"
          queuedTitle="Planning today's posts"
          icon={CalendarCheck}
          blockedReason={connectedPosting === 0 ? 'No connected account can post. Connect one under Accounts.' : null}
        />
        <RunAgentButton
          websiteId={website.id}
          agent="social-strategy"
          label="Suggest strategy"
          queuedTitle="Strategy queued — suggested topics appear under Topics"
          icon={Compass}
          blockedReason={aiConfigured ? null : noAi}
          variant="ghost"
        />
      </div>

      {agentReach.available ? (
        <Alert variant="success" icon={ShieldCheck}>
          <AlertTitle>agent-reach {agentReach.version ?? ''} is installed</AlertTitle>
          <AlertDescription>
            Listening can also read X, YouTube, GitHub, V2EX, Facebook and Instagram. agent-reach is read-only and never logs in
            for you; if a channel needs a login, run <code className="font-mono text-2xs">agent-reach login &lt;channel&gt;</code>{' '}
            yourself.
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="neutral">
          <AlertTitle>agent-reach is not installed — Reddit, Hacker News and Bluesky still work</AlertTitle>
          <AlertDescription>
            <p>
              Those three are read natively. To also listen on X, YouTube, GitHub, V2EX, Facebook and Instagram, install
              agent-reach on the worker machine.
            </p>
            <p className="mt-1 text-2xs text-muted-foreground">{agentReach.installHint}</p>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <MetricCard
          label="Worth answering"
          value={formatNumber(counts.shortlisted)}
          icon={Inbox}
          info="Threads the triage judged a genuine fit for a reply. New, untriaged threads are counted separately."
          footer={`${formatNumber(counts.newConversations)} new, not yet triaged`}
        />
        <MetricCard
          label="Awaiting approval"
          value={formatNumber(counts.awaitingApproval)}
          icon={ShieldCheck}
          info="Drafts waiting for your decision in Approvals. Replies in other communities always stop here."
        />
        <MetricCard
          label="Scheduled"
          value={formatNumber(counts.scheduled)}
          icon={Send}
          info="Approved posts waiting for their slot. Guardrails are checked again when each goes out."
        />
        <MetricCard
          label="Post by hand"
          value={formatNumber(counts.manualPending)}
          icon={Hand}
          info="Approved posts for platforms with no posting API (Hacker News) or no connected account."
          footer={counts.failed > 0 ? `${formatNumber(counts.failed)} failed — see Posts` : undefined}
        />
        <MetricCard
          label="Published (7 days)"
          value={formatNumber(counts.published7d)}
          icon={Megaphone}
          info="Posts and replies that went out in the last seven days, through an API or marked as posted by hand."
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
        {data.agentRuns.map((run) => (
          <SimpleTooltip key={run.key} content={<span className="block max-w-sm">{run.summary ?? 'No summary.'}</span>}>
            <span className="inline-flex cursor-default items-center gap-1.5">
              {run.label}:
              {run.status ? (
                <>
                  <Badge variant={RUN_STATUS_VARIANT[run.status] ?? 'muted'} className="font-normal">
                    {run.status.toLowerCase()}
                  </Badge>
                  {relativeTime(run.finishedAt ?? run.startedAt)}
                </>
              ) : (
                ' never run'
              )}
            </span>
          </SimpleTooltip>
        ))}
        <span>· {activeTopics} active topic{activeTopics === 1 ? '' : 's'}</span>
      </div>

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList className="max-w-full overflow-x-auto">
          {SOCIAL_TABS.map((entry) => (
            <TabsTrigger key={entry} value={entry}>
              {TAB_LABEL[entry]}
              {entry === 'inbox' && counts.shortlisted > 0 ? (
                <Badge variant="success" className="ml-1.5 font-normal">
                  {counts.shortlisted}
                </Badge>
              ) : null}
              {entry === 'posts' && counts.manualPending + counts.failed > 0 ? (
                <Badge variant="warning" className="ml-1.5 font-normal">
                  {counts.manualPending + counts.failed}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="inbox" className="mt-5">
          <InboxTab data={data} onWriteReply={(conversation) => setCompose({ mode: 'reply', conversation })} />
        </TabsContent>
        <TabsContent value="posts" className="mt-5">
          <PostsTab data={data} onNewPost={() => setCompose({ mode: 'new' })} onEdit={(post) => setCompose({ mode: 'edit', post })} />
        </TabsContent>
        <TabsContent value="topics" className="mt-5">
          <TopicsTab data={data} />
        </TabsContent>
        <TabsContent value="accounts" className="mt-5">
          <AccountsTab data={data} />
        </TabsContent>
        <TabsContent value="settings" className="mt-5">
          <SettingsTab data={data} />
        </TabsContent>
      </Tabs>

      <ComposeDialog target={compose} context={composeContext} onClose={() => setCompose(null)} />
    </div>
  );
}
