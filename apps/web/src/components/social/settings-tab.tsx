'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Gauge, Timer } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { apiPatch, apiPost } from '@/lib/api-client';
import { reportApiError } from '@/lib/job-feedback';
import { formatDateTime, relativeTime } from './format';
import { SOCIAL_SCHEDULE_LABELS, type SocialOverview } from './types';

/**
 * The site's social guardrail settings and the automation switch.
 *
 * The caps can be tightened here but not lifted past the platform's hard limits — the API
 * enforces the same bounds the guardrails clamp to. The autonomy copy states plainly what runs
 * without a human, because "automation on" is otherwise easy to read as "posts anywhere".
 */

const AUTONOMY_LABEL: Record<string, string> = {
  L0_INSIGHTS_ONLY: 'Level 0 — insights only',
  L1_DRAFTS_ONLY: 'Level 1 — drafts only',
  L2_SAFE_TECHNICAL: 'Level 2 — safe technical changes',
  L3_MOST_REVERSIBLE: 'Level 3 — most reversible changes',
  L4_HIGH_AUTONOMY: 'Level 4 — high autonomy',
};

export function SettingsTab({ data }: { data: SocialOverview }): React.JSX.Element {
  const router = useRouter();
  const ids = useId();
  const { settings, hardLimits, website, schedules } = data;

  const [postLimit, setPostLimit] = useState(String(settings.socialDailyPostLimit));
  const [replyLimit, setReplyLimit] = useState(String(settings.socialDailyReplyLimit));
  const [promoPct, setPromoPct] = useState(String(Math.round(settings.socialMaxPromoRatio * 100)));
  const [disclosure, setDisclosure] = useState(settings.socialDisclosure ?? '');
  const [campaign, setCampaign] = useState(settings.socialUtmCampaign);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const automationOn = schedules.length > 0 && schedules.every((schedule) => schedule.isEnabled);
  const highAutonomy = settings.autonomyLevel === 'L4_HIGH_AUTONOMY';

  const postValue = Number(postLimit);
  const replyValue = Number(replyLimit);
  const promoValue = Number(promoPct);
  const errors = {
    post:
      Number.isInteger(postValue) && postValue >= 1 && postValue <= hardLimits.dailyPostsPerAccount
        ? null
        : `Between 1 and ${hardLimits.dailyPostsPerAccount}.`,
    reply:
      Number.isInteger(replyValue) && replyValue >= 0 && replyValue <= hardLimits.dailyReplies
        ? null
        : `Between 0 and ${hardLimits.dailyReplies}.`,
    promo:
      Number.isFinite(promoValue) && promoValue >= 0 && promoValue <= hardLimits.maxPromoRatio * 100
        ? null
        : `Between 0 and ${Math.round(hardLimits.maxPromoRatio * 100)}%.`,
    campaign: /^[a-z0-9_-]+$/i.test(campaign.trim()) ? null : 'Letters, digits, dashes or underscores only.',
  };
  const valid = Object.values(errors).every((error) => error === null);

  async function save(): Promise<void> {
    setSaving(true);
    try {
      await apiPatch('/api/social/settings', {
        websiteId: website.id,
        socialDailyPostLimit: postValue,
        socialDailyReplyLimit: replyValue,
        socialMaxPromoRatio: Math.round(promoValue) / 100,
        socialDisclosure: disclosure.trim() || null,
        socialUtmCampaign: campaign.trim(),
      });
      toast.success('Social settings saved', { description: 'They apply from the next draft and at every publish.' });
      router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not save the settings.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleAutomation(enabled: boolean): Promise<void> {
    setToggling(true);
    try {
      const result = await apiPost<{ synced: boolean }>('/api/social/automation', { websiteId: website.id, enabled });
      toast.success(enabled ? 'Social automation on' : 'Social automation off', {
        description: result.synced
          ? undefined
          : 'Saved, but the schedules could not be pushed to the queue right now — they register when the worker and Redis are back.',
      });
      router.refresh();
    } catch (error) {
      reportApiError(error, 'Could not change the automation.');
    } finally {
      setToggling(false);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge aria-hidden="true" className="size-4" />
            Limits and disclosure
          </CardTitle>
          <CardDescription>
            Applied when a draft is proposed and again when it is published. The hard limits cannot be raised from here.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              label="Posts per account per day"
              htmlFor={`${ids}-posts`}
              error={errors.post}
              description={`Hard limit ${hardLimits.dailyPostsPerAccount}.`}
            >
              <Input id={`${ids}-posts`} type="number" inputMode="numeric" min={1} max={hardLimits.dailyPostsPerAccount} value={postLimit} onChange={(event) => setPostLimit(event.target.value)} />
            </FormField>
            <FormField
              label="Replies per day"
              htmlFor={`${ids}-replies`}
              error={errors.reply}
              description={`All platforms. Hard limit ${hardLimits.dailyReplies}.`}
            >
              <Input id={`${ids}-replies`} type="number" inputMode="numeric" min={0} max={hardLimits.dailyReplies} value={replyLimit} onChange={(event) => setReplyLimit(event.target.value)} />
            </FormField>
            <FormField
              label="Max share with a link"
              htmlFor={`${ids}-promo`}
              error={errors.promo}
              description={`% of the last 30 days. Hard limit ${Math.round(hardLimits.maxPromoRatio * 100)}%.`}
            >
              <Input id={`${ids}-promo`} type="number" inputMode="numeric" min={0} max={Math.round(hardLimits.maxPromoRatio * 100)} value={promoPct} onChange={(event) => setPromoPct(event.target.value)} />
            </FormField>
          </div>
          <p className="text-2xs text-muted-foreground">
            Also fixed, whatever these say: one reply per thread, at most two replies per community per week, no replies to
            threads older than 14 days, and no page shared twice on one platform within 30 days.
          </p>
          <FormField
            label="Disclosure sentence"
            htmlFor={`${ids}-disclosure`}
            description={`Used whenever a reply names or links ${website.brandName ?? website.name}. Empty means the default "Disclosure: I build ${website.brandName ?? website.name}."`}
          >
            <Input
              id={`${ids}-disclosure`}
              value={disclosure}
              placeholder={`I'm the founder of ${website.brandName ?? website.name}.`}
              onChange={(event) => setDisclosure(event.target.value)}
            />
          </FormField>
          <FormField
            label="UTM campaign"
            htmlFor={`${ids}-campaign`}
            error={errors.campaign}
            description="utm_campaign on links the agents share, so social referrals are attributable in analytics."
          >
            <Input id={`${ids}-campaign`} value={campaign} onChange={(event) => setCampaign(event.target.value)} className="font-mono text-xs" />
          </FormField>
          <div className="flex justify-end">
            <Button onClick={() => void save()} disabled={!valid} loading={saving} loadingText="Saving">
              Save settings
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-6">
        <Alert variant={highAutonomy ? 'warning' : 'info'}>
          <AlertTitle>What runs without you — {AUTONOMY_LABEL[settings.autonomyLevel] ?? settings.autonomyLevel}</AlertTitle>
          <AlertDescription>
            <p>
              Replies in other communities always need your approval, at every autonomy level. Posts on your own channels
              publish automatically only at Level 4; below that they wait in Approvals.
              {highAutonomy
                ? ' This site is at Level 4, so daily posts on your connected accounts go out on their own.'
                : ' This site is below Level 4, so every post waits for you.'}
            </p>
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link href={`/sites/${website.id}/settings`}>Change the autonomy level</Link>
            </Button>
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Timer aria-hidden="true" className="size-4" />
                  Automation
                </CardTitle>
                <CardDescription>
                  Listen every four hours, draft replies for the shortlist, plan daily posts each morning, publish what is
                  approved and due, and read engagement back.
                </CardDescription>
              </div>
              <Switch
                checked={automationOn}
                disabled={toggling}
                aria-label={automationOn ? 'Turn social automation off' : 'Turn social automation on'}
                onCheckedChange={(value) => void toggleAutomation(value)}
              />
            </div>
          </CardHeader>
          <CardContent>
            {schedules.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Off. Turning it on creates five schedules you can re-time on the{' '}
                <Link href={`/sites/${website.id}/automations`} className="text-primary hover:underline">
                  Automations
                </Link>{' '}
                screen. Times are UTC.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {schedules.map((schedule) => {
                  const meta = SOCIAL_SCHEDULE_LABELS[schedule.name];
                  return (
                    <li key={schedule.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-sm font-medium text-foreground">{meta?.label ?? schedule.name}</p>
                        <p className="text-xs text-muted-foreground">{meta?.description ?? schedule.jobName}</p>
                        <p className="font-mono text-2xs text-muted-foreground">{schedule.cron} (UTC)</p>
                      </div>
                      <div className="text-right text-xs">
                        {schedule.isEnabled ? (
                          <p className="text-foreground">Next {formatDateTime(schedule.nextRunAt)}</p>
                        ) : (
                          <Badge variant="muted">Paused</Badge>
                        )}
                        <p className="text-muted-foreground">
                          {schedule.lastRunAt ? `Last ${relativeTime(schedule.lastRunAt)}${schedule.lastStatus ? ` · ${schedule.lastStatus.toLowerCase()}` : ''}` : 'Never run'}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
