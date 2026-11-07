'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Pencil, Plus, Radar, Trash2, Users } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { EmptyState } from '@/components/ui/empty-state';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Section, SectionActions, SectionDescription, SectionHeader, SectionTitle } from '@/components/ui/section';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { apiDelete, apiPatch, apiPost } from '@/lib/api-client';
import { reportApiError } from '@/lib/job-feedback';
import { formatCompact } from '@/lib/utils';
import { PlatformBadge, PolicyBadge } from './badges';
import { PLATFORM_LABEL, POLICY_META, relativeTime } from './format';
import type { PolicyValue, SocialCommunityRow, SocialOverview, SocialPlatformValue, SocialTopicRow, TopicKindValue } from './types';

/**
 * What to listen for, and where.
 *
 * Topics are phrased the way the audience describes the problem, not the way marketing names the
 * product — the form says so, because a brand-slogan query mostly finds nothing. Communities are
 * collected as listening finds them; their self-promotion policy is read from their own rules,
 * and the operator can block one or correct a misread policy here.
 */

const KIND_LABEL: Record<TopicKindValue, string> = {
  problem: 'Problem',
  brand: 'Brand mentions',
  competitor: 'Competitor / alternatives',
};

interface TopicDraft {
  name: string;
  query: string;
  keywords: string;
  negativeKeywords: string;
  platforms: SocialPlatformValue[];
  communities: string;
  kind: TopicKindValue;
  isActive: boolean;
}

function splitList(value: string): string[] {
  return [...new Set(value.split(',').map((entry) => entry.trim()).filter(Boolean))];
}

function emptyDraft(): TopicDraft {
  return {
    name: '',
    query: '',
    keywords: '',
    negativeKeywords: '',
    platforms: ['REDDIT', 'HACKER_NEWS'],
    communities: '',
    kind: 'problem',
    isActive: true,
  };
}

function draftFrom(topic: SocialTopicRow): TopicDraft {
  return {
    name: topic.name,
    query: topic.query,
    keywords: topic.keywords.join(', '),
    negativeKeywords: topic.negativeKeywords.join(', '),
    platforms: topic.platforms,
    communities: topic.communities.join(', '),
    kind: topic.kind,
    isActive: topic.isActive,
  };
}

export function TopicsTab({ data }: { data: SocialOverview }): React.JSX.Element {
  const router = useRouter();
  const [editing, setEditing] = useState<SocialTopicRow | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SocialTopicRow | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const toggleTopic = useCallback(
    async (topic: SocialTopicRow, isActive: boolean) => {
      setBusy(topic.id);
      try {
        await apiPatch(`/api/social/topics/${topic.id}`, { isActive });
        router.refresh();
      } catch (error) {
        reportApiError(error, 'Could not update the topic.');
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  async function removeTopic(): Promise<void> {
    if (!deleting) return;
    try {
      await apiDelete(`/api/social/topics/${deleting.id}`);
      toast.success('Topic removed', { description: 'Conversations it already found stay in the inbox.' });
      router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not remove the topic.');
    } finally {
      setDeleting(null);
    }
  }

  const updateCommunity = useCallback(
    async (community: SocialCommunityRow, patch: { isBlocked?: boolean; promotionPolicy?: PolicyValue }) => {
      setBusy(community.id);
      try {
        await apiPatch(`/api/social/communities/${community.id}`, patch);
        router.refresh();
      } catch (error) {
        reportApiError(error, 'Could not update the community.');
      } finally {
        setBusy(null);
      }
    },
    [router],
  );

  return (
    <div className="space-y-8">
      <Section>
        <SectionHeader>
          <SectionTitle>Listening topics</SectionTitle>
          <SectionDescription>
            Phrases your audience uses when they have the problem you solve — &ldquo;how do I track macros&rdquo;, not
            &ldquo;AI nutrition platform&rdquo;. Each one is searched on the platforms you pick.
          </SectionDescription>
          <SectionActions>
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus aria-hidden="true" />
              Add topic
            </Button>
          </SectionActions>
        </SectionHeader>

        {data.topics.length === 0 ? (
          <EmptyState
            bordered
            icon={Radar}
            title="No topics yet"
            description='Add one by hand, or use "Suggest strategy" to have the strategy agent propose topics from your site, search queries and competitors. A brand-mentions topic is also created automatically on the first listening run.'
            action={
              <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
                <Plus aria-hidden="true" />
                Add a topic
              </Button>
            }
          />
        ) : (
          <ul className="grid gap-3 lg:grid-cols-2">
            {data.topics.map((topic) => (
              <li key={topic.id}>
                <Card className={topic.isActive ? undefined : 'opacity-70'}>
                  <CardContent className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="truncate text-sm font-semibold text-foreground">{topic.name}</p>
                        <p className="break-words font-mono text-xs text-muted-foreground">&ldquo;{topic.query}&rdquo;</p>
                      </div>
                      <Switch
                        checked={topic.isActive}
                        disabled={busy === topic.id}
                        aria-label={topic.isActive ? `Pause ${topic.name}` : `Resume ${topic.name}`}
                        onCheckedChange={(value) => void toggleTopic(topic, value)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary" className="font-normal">
                        {KIND_LABEL[topic.kind]}
                      </Badge>
                      {topic.platforms.map((platform) => (
                        <PlatformBadge key={platform} platform={platform} />
                      ))}
                      {topic.source !== 'manual' ? (
                        <Badge variant="muted" className="font-normal">
                          {topic.source === 'ai' ? 'suggested' : 'automatic'}
                        </Badge>
                      ) : null}
                    </div>
                    {topic.communities.length ? (
                      <p className="text-xs text-muted-foreground">Only in: {topic.communities.join(', ')}</p>
                    ) : null}
                    {topic.keywords.length ? <p className="text-xs text-muted-foreground">Also: {topic.keywords.join(', ')}</p> : null}
                    {topic.negativeKeywords.length ? (
                      <p className="text-xs text-muted-foreground">Excluding: {topic.negativeKeywords.join(', ')}</p>
                    ) : null}
                    <p className="text-2xs text-muted-foreground">
                      {topic.lastRunAt
                        ? `Last searched ${relativeTime(topic.lastRunAt)} · ${topic.lastResultCount ?? 0} found · ${topic.conversationCount} kept`
                        : 'Not searched yet'}
                    </p>
                    {topic.lastError ? <p className="text-2xs text-warning">{topic.lastError}</p> : null}
                    <div className="flex gap-1 pt-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(topic)}>
                        <Pencil aria-hidden="true" />
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(topic)}>
                        <Trash2 aria-hidden="true" />
                        Remove
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section>
        <SectionHeader>
          <SectionTitle>Communities</SectionTitle>
          <SectionDescription>
            Where your conversations happen. The self-promotion policy is read from each community&rsquo;s own rules and
            decides whether a reply may name or link the product. Block a community to stop listening and posting there.
          </SectionDescription>
        </SectionHeader>

        {data.communities.length === 0 ? (
          <EmptyState
            bordered
            size="sm"
            icon={Users}
            title="No communities recorded yet"
            description="Communities appear here as listening finds threads in them, or when the strategy agent suggests some. Their rules are read on the next listening run."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="bg-muted/40 text-left text-2xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Community</th>
                  <th className="px-3 py-2 font-medium">Policy</th>
                  <th className="px-3 py-2 font-medium">What the rules say</th>
                  <th className="px-3 py-2 text-right font-medium">Members</th>
                  <th className="px-3 py-2 font-medium">Override</th>
                  <th className="px-3 py-2 font-medium">Blocked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.communities.map((community) => (
                  <tr key={community.id} className={community.isBlocked ? 'bg-muted/30' : undefined}>
                    <td className="px-3 py-2 align-top">
                      <div className="flex flex-col gap-1">
                        <span className="font-medium text-foreground">{community.name}</span>
                        <span className="text-2xs text-muted-foreground">
                          {PLATFORM_LABEL[community.platform]}
                          {community.lastCheckedAt ? ` · rules read ${relativeTime(community.lastCheckedAt)}` : ' · rules not read yet'}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <PolicyBadge policy={community.promotionPolicy} summary={community.rulesSummary} />
                    </td>
                    <td className="max-w-sm px-3 py-2 align-top text-xs text-muted-foreground">
                      {community.rulesSummary ?? community.notes ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right align-top tabular-nums">{formatCompact(community.subscribers)}</td>
                    <td className="px-3 py-2 align-top">
                      <Select
                        value={community.promotionPolicy}
                        onValueChange={(value) => {
                          const policy = (['ALLOWED', 'RESTRICTED', 'FORBIDDEN', 'UNKNOWN'] as const).find((entry) => entry === value);
                          if (policy) void updateCommunity(community, { promotionPolicy: policy });
                        }}
                        disabled={busy === community.id}
                      >
                        <SelectTrigger className="h-8 w-40 text-xs" aria-label={`Policy override for ${community.name}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['ALLOWED', 'RESTRICTED', 'FORBIDDEN', 'UNKNOWN'] as const).map((policy) => (
                            <SelectItem key={policy} value={policy}>
                              {POLICY_META[policy].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={community.isBlocked}
                          disabled={busy === community.id}
                          aria-label={community.isBlocked ? `Unblock ${community.name}` : `Block ${community.name}`}
                          onCheckedChange={(value) => void updateCommunity(community, { isBlocked: value })}
                        />
                        {community.isBlocked ? <Ban aria-hidden="true" className="size-3.5 text-destructive" /> : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.communities.length > 0 ? (
          <p className="text-2xs text-muted-foreground">
            An override is kept until the next rules refresh (every 30 days) re-reads the community. Blocking is permanent
            until you unblock.
          </p>
        ) : null}
      </Section>

      <TopicDialog
        websiteId={data.website.id}
        target={editing}
        listeningPlatforms={data.listeningPlatforms}
        agentReachAvailable={data.agentReach.available}
        onClose={() => setEditing(null)}
      />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        destructive
        title={`Remove "${deleting?.name ?? 'this topic'}"?`}
        description="Listening stops searching it. Conversations it already found stay in the inbox."
        confirmLabel="Remove topic"
        onConfirm={removeTopic}
      />
    </div>
  );
}

function TopicDialog({
  websiteId,
  target,
  listeningPlatforms,
  agentReachAvailable,
  onClose,
}: {
  websiteId: string;
  target: SocialTopicRow | 'new' | null;
  listeningPlatforms: SocialOverview['listeningPlatforms'];
  agentReachAvailable: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const ids = useId();
  const [draft, setDraft] = useState<TopicDraft>(emptyDraft);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (target === null) return;
    setDraft(target === 'new' ? emptyDraft() : draftFrom(target));
  }, [target]);

  const set = <K extends keyof TopicDraft>(key: K, value: TopicDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const canSave = draft.query.trim().length >= 3 && draft.platforms.length > 0 && !pending;

  async function save(): Promise<void> {
    if (target === null) return;
    setPending(true);
    const payload = {
      name: draft.name.trim() || draft.query.trim(),
      query: draft.query.trim(),
      keywords: splitList(draft.keywords),
      negativeKeywords: splitList(draft.negativeKeywords),
      platforms: draft.platforms,
      communities: splitList(draft.communities),
      kind: draft.kind,
      isActive: draft.isActive,
    };
    try {
      if (target === 'new') await apiPost('/api/social/topics', { websiteId, ...payload });
      else await apiPatch(`/api/social/topics/${target.id}`, payload);
      toast.success(target === 'new' ? 'Topic added' : 'Topic saved', { description: 'It is searched on the next listening run.' });
      onClose();
      router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not save the topic.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{target === 'new' ? 'Add a listening topic' : 'Edit topic'}</DialogTitle>
          <DialogDescription>Write it the way someone with the problem would type it into a search box or a post title.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          <FormField label="Search phrase" htmlFor={`${ids}-query`} required>
            <Input
              id={`${ids}-query`}
              value={draft.query}
              placeholder="e.g. how do I plan meals for the week"
              onChange={(event) => set('query', event.target.value)}
            />
          </FormField>
          <FormField label="Name" htmlFor={`${ids}-name`} description="Shown in the inbox. Defaults to the phrase.">
            <Input id={`${ids}-name`} value={draft.name} onChange={(event) => set('name', event.target.value)} />
          </FormField>
          <FormField label="Kind" htmlFor={`${ids}-kind`}>
            <Select
              value={draft.kind}
              onValueChange={(value) => {
                const kind = (['problem', 'brand', 'competitor'] as const).find((entry) => entry === value);
                if (kind) set('kind', kind);
              }}
            >
              <SelectTrigger id={`${ids}-kind`} aria-label="Kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['problem', 'brand', 'competitor'] as const).map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {KIND_LABEL[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-foreground">Platforms</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {listeningPlatforms.map(({ platform, needsAgentReach }) => {
                const checked = draft.platforms.includes(platform);
                const unavailable = needsAgentReach && !agentReachAvailable;
                return (
                  <label key={platform} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(value) =>
                        set(
                          'platforms',
                          value === true ? [...draft.platforms, platform] : draft.platforms.filter((entry) => entry !== platform),
                        )
                      }
                    />
                    <span className="min-w-0">
                      {PLATFORM_LABEL[platform]}
                      {needsAgentReach ? (
                        <span className={unavailable ? 'block text-2xs text-warning' : 'block text-2xs text-muted-foreground'}>
                          {unavailable ? 'needs agent-reach (not installed)' : 'via agent-reach'}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="text-2xs text-muted-foreground">
              Reddit, Hacker News and Bluesky are read natively. The others are read through agent-reach, which is
              read-only and never logs in for you.
            </p>
          </fieldset>

          <FormField
            label="Only in these communities"
            htmlFor={`${ids}-communities`}
            description="Comma-separated subreddits, e.g. r/MealPrepSunday, r/EatCheapAndHealthy. Empty searches all of Reddit."
          >
            <Input id={`${ids}-communities`} value={draft.communities} onChange={(event) => set('communities', event.target.value)} />
          </FormField>
          <FormField label="Extra keywords" htmlFor={`${ids}-keywords`} description="Comma-separated. A thread mentioning any of them ranks higher.">
            <Input id={`${ids}-keywords`} value={draft.keywords} onChange={(event) => set('keywords', event.target.value)} />
          </FormField>
          <FormField
            label="Exclude"
            htmlFor={`${ids}-negative`}
            description="Comma-separated. A thread containing any of these is dropped — job posts, unrelated meanings."
          >
            <Input id={`${ids}-negative`} value={draft.negativeKeywords} onChange={(event) => set('negativeKeywords', event.target.value)} />
          </FormField>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <label htmlFor={`${ids}-active`} className="text-sm font-medium text-foreground">
              Active
            </label>
            <Switch id={`${ids}-active`} checked={draft.isActive} onCheckedChange={(value) => set('isActive', value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} loading={pending} loadingText="Saving">
            {target === 'new' ? 'Add topic' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
