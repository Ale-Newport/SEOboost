'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { apiPatch, apiPost } from '@/lib/api-client';
import { reportApiError, reportJobResult, type JobResponse } from '@/lib/job-feedback';
import { cn } from '@/lib/utils';
import { fromLocalInput, looksDisclosed, mentionsAny, PLATFORM_LABEL, platformLength, toLocalInput } from './format';
import type {
  PlatformTextRulesWire,
  SocialAccountRow,
  SocialConversationRow,
  SocialPlatformValue,
  SocialPostRow,
} from './types';

/**
 * One composer for three jobs: a new post on an owned channel, a reply the operator writes
 * themselves, and editing a post that has not gone out yet.
 *
 * The counter counts the way the platform does, and the disclosure check runs as you type: a
 * reply that names the product without saying who wrote it is blocked at publish time anyway,
 * so the dialog says so before the operator saves rather than after a job fails.
 */

export type ComposeTarget =
  | { mode: 'new' }
  | { mode: 'reply'; conversation: SocialConversationRow }
  | { mode: 'edit'; post: SocialPostRow };

export interface ComposeContext {
  websiteId: string;
  accounts: SocialAccountRow[];
  textRules: Record<SocialPlatformValue, PlatformTextRulesWire>;
  brandTerms: string[];
  brandName: string;
  disclosure: string | null;
  /** Platforms with no posting API that can still be prepared for a human to post. */
  manualPlatforms: SocialPlatformValue[];
}

/** Platforms whose publisher turns `linkUrl` into a card on its own, so the link need not sit in the text. */
const LINK_CARD_PLATFORMS = new Set<SocialPlatformValue>(['DEVTO']);

/** `account:<id>` for a connected account, `manual:<PLATFORM>` for hand-posted platforms. */
type ChannelValue = string;

export function ComposeDialog({
  target,
  context,
  onClose,
}: {
  target: ComposeTarget | null;
  context: ComposeContext;
  onClose: () => void;
}): React.JSX.Element {
  const router = useRouter();
  const ids = useId();
  const connected = context.accounts.filter((account) => account.status === 'CONNECTED' && account.canPost);

  const [channel, setChannel] = useState<ChannelValue>('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [link, setLink] = useState('');
  const [community, setCommunity] = useState('');
  const [schedule, setSchedule] = useState('');
  const [pending, setPending] = useState(false);

  // Reset the form whenever a different target opens the dialog.
  useEffect(() => {
    if (!target) return;
    if (target.mode === 'edit') {
      setTitle(target.post.title ?? '');
      setBody(target.post.body);
      setCommunity(target.post.community ?? '');
      setSchedule(toLocalInput(target.post.scheduledFor));
      setLink('');
      setChannel(target.post.accountId ? `account:${target.post.accountId}` : `manual:${target.post.platform}`);
    } else if (target.mode === 'reply') {
      setTitle('');
      setBody('');
      setLink('');
      setCommunity('');
      setSchedule('');
      const account = connected.find((row) => row.platform === target.conversation.platform);
      setChannel(account ? `account:${account.id}` : `manual:${target.conversation.platform}`);
    } else {
      setTitle('');
      setBody('');
      setLink('');
      setCommunity('');
      setSchedule('');
      setChannel(connected[0] ? `account:${connected[0].id}` : context.manualPlatforms[0] ? `manual:${context.manualPlatforms[0]}` : '');
    }
    // `connected` is derived from props on every render; the reset must only follow the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const account = channel.startsWith('account:') ? connected.find((row) => `account:${row.id}` === channel) ?? null : null;
  const platform: SocialPlatformValue | null =
    target?.mode === 'reply'
      ? target.conversation.platform
      : target?.mode === 'edit'
        ? target.post.platform
        : account
          ? account.platform
          : channel.startsWith('manual:')
            ? (context.manualPlatforms.find((value) => `manual:${value}` === channel) ?? null)
            : null;
  const rules = platform ? context.textRules[platform] : null;
  const isReply = target?.mode === 'reply' || (target?.mode === 'edit' && target.post.kind === 'REPLY');
  const needsTitle = !isReply && rules?.titleLimit !== null && rules?.titleLimit !== undefined;

  const finalBody = useMemo(() => {
    const trimmed = body.trim();
    const url = link.trim();
    if (!url || !platform || LINK_CARD_PLATFORMS.has(platform) || trimmed.includes(url)) return trimmed;
    return `${trimmed}\n\n${url}`;
  }, [body, link, platform]);

  const length = rules ? platformLength(finalBody, rules) : finalBody.length;
  const overLimit = rules ? length > rules.bodyLimit : false;
  const namesBrand = mentionsAny(finalBody, context.brandTerms);
  const linksSite = context.brandTerms.some((term) => term.includes('.') && finalBody.toLowerCase().includes(term.toLowerCase()));
  const needsDisclosure = (namesBrand || linksSite) && isReply && !looksDisclosed(finalBody, context.disclosure);
  const disclosureSentence = context.disclosure?.trim() || `Disclosure: I build ${context.brandName}.`;

  const titleMissing = needsTitle && (platform === 'REDDIT' || platform === 'HACKER_NEWS' || platform === 'DEVTO') && !title.trim();
  const canSave = Boolean(platform) && finalBody.length >= 2 && !overLimit && !titleMissing && !pending;

  async function save(): Promise<void> {
    if (!target || !platform) return;
    setPending(true);
    try {
      if (target.mode === 'edit') {
        await apiPatch(`/api/social/posts/${target.post.id}`, {
          body: finalBody,
          ...(needsTitle ? { title: title.trim() || null } : {}),
          ...(target.post.kind === 'ORIGINAL' ? { scheduledFor: fromLocalInput(schedule) } : {}),
          ...(platform === 'REDDIT' && target.post.kind === 'ORIGINAL' ? { community: community.trim() || null } : {}),
        });
        toast.success('Post updated', { description: 'The text waiting for approval is the text that will be published.' });
        onClose();
        router.refresh();
        return;
      }

      const result = await apiPost<JobResponse & { postId?: string }>('/api/social/posts', {
        websiteId: context.websiteId,
        kind: target.mode === 'reply' ? 'REPLY' : 'ORIGINAL',
        platform,
        accountId: account?.id ?? null,
        conversationId: target.mode === 'reply' ? target.conversation.id : null,
        title: needsTitle ? title.trim() || null : null,
        body: finalBody,
        linkUrl: link.trim() || null,
        community: platform === 'REDDIT' && target.mode === 'new' ? community.trim() || null : null,
        scheduledFor: target.mode === 'new' ? fromLocalInput(schedule) : null,
      });
      const manual = !account;
      reportJobResult(
        result,
        manual
          ? 'Ready to post by hand — find it under Posts'
          : schedule
            ? 'Scheduled — guardrails are checked again when it goes out'
            : 'Queued for publishing',
      );
      onClose();
      router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not save the post.');
    } finally {
      setPending(false);
    }
  }

  const heading =
    target?.mode === 'reply' ? 'Write a reply' : target?.mode === 'edit' ? 'Edit post' : 'New post on your channel';

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription>
            {target?.mode === 'reply'
              ? 'You are writing as yourself, in someone else’s community. Answer their question first; mention the product only if it genuinely fits, and say you built it.'
              : target?.mode === 'edit'
                ? 'Edits apply to what will be published. Caps, cooldowns and community rules are checked again at publish time.'
                : 'Posted from your own connected account. Caps and the 30-day repost cooldown are checked again when it goes out.'}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {target?.mode === 'reply' ? (
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium text-foreground">{target.conversation.title ?? 'Untitled thread'}</p>
              {target.conversation.body ? (
                <p className="mt-1 line-clamp-4 whitespace-pre-line text-xs text-muted-foreground">{target.conversation.body}</p>
              ) : null}
              <a
                href={target.conversation.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-xs text-primary hover:underline"
              >
                Read the whole thread first
              </a>
            </div>
          ) : null}

          {target?.mode === 'new' ? (
            <FormField
              label="Channel"
              htmlFor={`${ids}-channel`}
              required
              description={
                connected.length === 0
                  ? 'No account is connected yet — connect one under Accounts to publish automatically. Hacker News is always posted by hand.'
                  : 'Your own connected accounts, plus platforms you post to by hand.'
              }
            >
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger id={`${ids}-channel`} aria-label="Channel">
                  <SelectValue placeholder="Choose where to post" />
                </SelectTrigger>
                <SelectContent>
                  {connected.map((row) => (
                    <SelectItem key={row.id} value={`account:${row.id}`}>
                      {PLATFORM_LABEL[row.platform]}
                      {row.handle ? ` — ${row.handle}` : ''}
                    </SelectItem>
                  ))}
                  {context.manualPlatforms.map((value) => (
                    <SelectItem key={value} value={`manual:${value}`}>
                      {PLATFORM_LABEL[value]} — post by hand
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormField>
          ) : null}

          {needsTitle ? (
            <FormField
              label="Title"
              htmlFor={`${ids}-title`}
              required={titleMissing || platform === 'REDDIT' || platform === 'HACKER_NEWS' || platform === 'DEVTO'}
              description={rules?.titleLimit ? `Up to ${rules.titleLimit} characters. Descriptive, not clickbait.` : undefined}
            >
              <Input
                id={`${ids}-title`}
                value={title}
                maxLength={rules?.titleLimit ?? undefined}
                onChange={(event) => setTitle(event.target.value)}
              />
            </FormField>
          ) : null}

          {platform === 'REDDIT' && !isReply ? (
            <FormField
              label="Subreddit"
              htmlFor={`${ids}-community`}
              description="Leave empty to post to the account's default (usually your profile). A subreddit you do not own always goes through Approvals, whatever the autonomy level."
            >
              <Input
                id={`${ids}-community`}
                value={community}
                placeholder="r/yourcommunity"
                onChange={(event) => setCommunity(event.target.value)}
              />
            </FormField>
          ) : null}

          <FormField
            label={isReply ? 'Reply' : 'Post'}
            htmlFor={`${ids}-body`}
            required
            error={overLimit && rules ? `Too long: ${length} of ${rules.bodyLimit} characters.` : undefined}
          >
            <Textarea id={`${ids}-body`} rows={8} value={body} onChange={(event) => setBody(event.target.value)} />
          </FormField>
          <p className={cn('-mt-2 text-right text-2xs tabular-nums', overLimit ? 'text-destructive' : 'text-muted-foreground')}>
            {length}
            {rules ? ` / ${rules.bodyLimit}` : ''}
            {rules?.urlWeight ? ` · links count as ${rules.urlWeight}` : ''}
          </p>

          {needsDisclosure ? (
            <Alert variant="warning" icon={ShieldAlert}>
              <AlertTitle>Say that you built it</AlertTitle>
              <AlertDescription>
                <p>
                  This reply names or links {context.brandName} without disclosing your affiliation. Undisclosed
                  self-promotion is astroturfing — the guardrail will refuse to publish it.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => setBody((current) => `${current.trim()}\n\n${disclosureSentence}`)}
                >
                  Add “{disclosureSentence}”
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}


          {target?.mode !== 'edit' ? (
            <FormField
              label="Link (optional)"
              htmlFor={`${ids}-link`}
              description="Added to the end of the text unless it is already there. Tag it yourself, or leave it untagged — the agents add UTM tags to the links they write."
            >
              <Input
                id={`${ids}-link`}
                type="url"
                value={link}
                placeholder={`https://${context.brandTerms.find((term) => term.includes('.')) ?? 'example.com'}/…`}
                onChange={(event) => setLink(event.target.value)}
              />
            </FormField>
          ) : null}

          {!isReply ? (
            <FormField
              label="Schedule (optional)"
              htmlFor={`${ids}-schedule`}
              description="Your local time. Empty means as soon as the publisher runs."
            >
              <Input
                id={`${ids}-schedule`}
                type="datetime-local"
                value={schedule}
                onChange={(event) => setSchedule(event.target.value)}
              />
            </FormField>
          ) : null}

          {platform && !account && target?.mode !== 'edit' ? (
            <p className="text-xs text-muted-foreground">
              {PLATFORM_LABEL[platform]} will not be posted automatically
              {context.manualPlatforms.includes(platform) ? ' (it has no posting API)' : ' (no connected account)'}: after saving,
              open it from Posts, post it yourself, and mark it as published.
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canSave} loading={pending} loadingText="Saving">
            {target?.mode === 'edit' ? 'Save changes' : account ? (schedule ? 'Schedule' : 'Publish') : 'Prepare for posting'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
