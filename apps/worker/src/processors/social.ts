/**
 * The social lane: publishing approved posts and reading their engagement back.
 *
 * Social actions ride the same guardrail as every other action — `canAutoExecute` re-evaluated
 * from current settings, or an `APPROVED` Approval row — and then a second, social-specific set
 * of guardrails inside `publishSocialPost` (caps, cooldowns, community rules, disclosure). What
 * they deliberately do not get is an `Experiment`: a social post is not a change to the site, and
 * a Search Console before/after test on it would measure noise and call it a result.
 *
 * `@seo/agents` is loaded dynamically, as in `lib/agent-runtime.ts`, so a deployment without the
 * agent package still boots and reports these jobs as skipped.
 */

import {
  ActionStatus,
  ApprovalStatus,
  NotificationSeverity,
  type SeoAction,
  json,
  prisma,
} from '@seo/db';
import type { JobContext, JobHandler } from '@seo/queue';
import { getPublisher } from '@seo/integrations';
import { canAutoExecute, riskBandForActionType } from '@seo/seo-engine';
import { createLogger, errorMessage, truncate } from '@seo/shared';
import { effectiveSettings, loadWebsite } from '../lib/website';
import { skip, type SkippedOutcome } from '../lib/result';

const log = createLogger('worker:social');

type SocialModule = Pick<typeof import('@seo/agents'), 'publishSocialPost' | 'duePosts' | 'refreshSocialMetrics'>;

let socialModule: SocialModule | null = null;
let socialLoadError: string | null = null;

async function loadSocial(): Promise<SocialModule | null> {
  if (socialModule) return socialModule;
  if (socialLoadError) return null;
  try {
    const loaded: unknown = await import('@seo/agents');
    const candidate = loaded as Partial<SocialModule>;
    if (typeof candidate.publishSocialPost !== 'function' || typeof candidate.duePosts !== 'function' || typeof candidate.refreshSocialMetrics !== 'function') {
      socialLoadError = 'The @seo/agents package does not export the social publishing functions.';
      return null;
    }
    // Checked above: the three functions this lane calls exist.
    socialModule = candidate as SocialModule;
    return socialModule;
  } catch (err) {
    socialLoadError = errorMessage(err);
    log.warn('agent package could not be loaded; social jobs will report as skipped', { error: socialLoadError });
    return null;
  }
}

export const SOCIAL_ACTION_TYPES = new Set<string>(['SOCIAL_REPLY', 'SOCIAL_POST']);

export interface SocialExecuteResult {
  status: 'completed';
  actionId: string;
  postId: string;
  outcome: string;
  url: string | null;
  warnings: string[];
}

/**
 * Execute one social action: guardrail, publish, audit trail.
 *
 * Shared by `actions.execute` (an approval was just given, or an operator pressed "execute") and
 * `social.dispatch` (a scheduled post fell due), so both paths enforce exactly the same checks.
 */
export async function executeSocialAction(
  action: SeoAction,
  opts: { approvalId?: string; dryRun?: boolean; ctx: Pick<JobContext, 'updateProgress'> },
): Promise<SocialExecuteResult | SkippedOutcome> {
  const social = await loadSocial();
  if (!social) return skip(`Social publishing is unavailable in this deployment: ${socialLoadError ?? 'agent package missing'}.`);

  const website = await loadWebsite(action.websiteId);
  const settings = effectiveSettings(website);
  const guard = canAutoExecute({ actionType: action.type, autonomyLevel: settings.autonomyLevel, autoApproveSafe: settings.autoApproveSafe });
  const approval = opts.approvalId
    ? await prisma.approval.findFirst({ where: { id: opts.approvalId, websiteId: website.id, actionId: action.id } })
    : await prisma.approval.findFirst({ where: { actionId: action.id, status: ApprovalStatus.APPROVED }, orderBy: { decidedAt: 'desc' } });
  const hasApproval = approval?.status === ApprovalStatus.APPROVED;

  if (!guard.allowed && !hasApproval) {
    const pending = await prisma.approval.findFirst({ where: { actionId: action.id, status: ApprovalStatus.PENDING }, select: { id: true } });
    if (!pending) {
      await prisma.approval.create({
        data: {
          websiteId: website.id,
          actionId: action.id,
          kind: action.type,
          title: action.title,
          description: action.reasoning,
          risk: riskBandForActionType(action.type),
          status: ApprovalStatus.PENDING,
          payload: json(action.payload),
        },
      });
    }
    await prisma.seoAction.update({ where: { id: action.id }, data: { status: ActionStatus.AWAITING_APPROVAL } });
    return skip(guard.reason, ['Approve this post in the Approvals queue']);
  }

  const post = await prisma.socialPost.findUnique({ where: { actionId: action.id }, select: { id: true, body: true, platform: true } });
  if (!post) return skip(`No social post is attached to action ${action.id}.`);
  if (opts.dryRun) {
    return { status: 'completed', actionId: action.id, postId: post.id, outcome: 'dry-run', url: null, warnings: ['Dry run — nothing was posted.'] };
  }

  await opts.ctx.updateProgress(40, 'Checking social guardrails and publishing');
  const startedAt = new Date();
  const outcome = await social.publishSocialPost(post.id);
  const finishedAt = new Date();
  const attempt = (await prisma.actionExecution.count({ where: { actionId: action.id } })) + 1;

  const record = async (status: string, response: Record<string, unknown>, error: string | null) =>
    prisma.actionExecution.create({
      data: {
        actionId: action.id,
        attempt,
        status,
        adapter: `social:${post.platform.toLowerCase()}`,
        request: json({ postId: post.id, body: truncate(post.body, 2_000) }),
        response: json(response),
        error,
        startedAt,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      },
    });

  switch (outcome.status) {
    case 'published': {
      const removable = getPublisher(post.platform)?.capabilities.remove ?? false;
      await record('COMPLETED', { url: outcome.url, externalId: outcome.externalId }, null);
      await prisma.seoAction.update({
        where: { id: action.id },
        data: { status: ActionStatus.COMPLETED, executedAt: startedAt, completedAt: finishedAt, error: null },
      });
      await prisma.changeLog.create({
        data: {
          websiteId: website.id,
          actionId: action.id,
          userId: approval?.userId ?? null,
          actor: hasApproval ? 'user' : 'agent',
          agent: action.requiredAgent,
          changeType: 'SOCIAL_POST_PUBLISHED',
          targetUrl: outcome.url,
          summary: `Published on ${post.platform}${outcome.url ? `: ${outcome.url}` : ''}`,
          afterState: json({ externalId: outcome.externalId, url: outcome.url, body: truncate(post.body, 2_000) }),
          reason: action.reasoning,
          approved: hasApproval || guard.allowed,
          rollbackable: removable,
        },
      });
      return { status: 'completed', actionId: action.id, postId: post.id, outcome: 'published', url: outcome.url, warnings: outcome.warnings };
    }
    case 'manual': {
      await record('MANUAL', { manualUrl: outcome.manualUrl }, null);
      await prisma.seoAction.update({ where: { id: action.id }, data: { status: ActionStatus.APPROVED, error: null } });
      await prisma.notification.create({
        data: {
          websiteId: website.id,
          type: 'social.manual-post',
          severity: NotificationSeverity.INFO,
          title: `Ready to post by hand on ${post.platform}`,
          message: outcome.reason,
          link: `/sites/${website.id}/social?tab=posts`,
          data: json({ postId: post.id, manualUrl: outcome.manualUrl }),
        },
      });
      return skip(outcome.reason, ['Post it from Social → Posts, then mark it as published']);
    }
    case 'scheduled':
      return skip(`Scheduled for ${outcome.scheduledFor.toISOString()}; the social dispatcher publishes it when it falls due.`);
    case 'deferred':
      return skip(`The platform asked us to slow down; retrying at ${outcome.retryAt.toISOString()}. ${outcome.reason}`);
    case 'noop':
      return skip(outcome.reason);
    case 'blocked': {
      const message = `Blocked at publish time: ${outcome.blockers.join(' ')}`;
      await record('BLOCKED', { blockers: outcome.blockers, warnings: outcome.warnings }, truncate(message, 2_000));
      await prisma.seoAction.update({ where: { id: action.id }, data: { status: ActionStatus.FAILED, error: truncate(message, 2_000) } });
      await prisma.notification.create({
        data: {
          websiteId: website.id,
          type: 'social.blocked',
          severity: NotificationSeverity.WARNING,
          title: `A ${post.platform} post was held back`,
          message,
          link: `/sites/${website.id}/social?tab=posts`,
          data: json({ postId: post.id }),
        },
      });
      return skip(message);
    }
    case 'failed': {
      await record('FAILED', { code: outcome.code }, truncate(outcome.error, 2_000));
      await prisma.seoAction.update({ where: { id: action.id }, data: { status: ActionStatus.FAILED, error: truncate(outcome.error, 2_000) } });
      // A failed post is never retried automatically (publishSocialPost treats FAILED as final until
      // a human retries), so throwing here only surfaces the failure — it cannot double-post.
      throw new Error(`Publishing to ${post.platform} failed: ${outcome.error}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// social.dispatch
// ─────────────────────────────────────────────────────────────

export const socialDispatch: JobHandler<'social.dispatch'> = async ({ payload, ctx }) => {
  const social = await loadSocial();
  if (!social) return skip(`Social publishing is unavailable in this deployment: ${socialLoadError ?? 'agent package missing'}.`);

  const due = payload.postId
    ? await prisma.socialPost.findMany({ where: { id: payload.postId }, select: { id: true, websiteId: true, actionId: true } })
    : await social.duePosts(payload.websiteId);
  if (due.length === 0) return skip('No approved social post is due.');

  const results: Array<{ postId: string; outcome: string }> = [];
  let index = 0;
  for (const post of due) {
    index++;
    await ctx.updateProgress(Math.round((index / due.length) * 100), `Publishing ${index}/${due.length}`);
    const action = post.actionId ? await prisma.seoAction.findUnique({ where: { id: post.actionId } }) : null;
    if (!action) {
      results.push({ postId: post.id, outcome: 'no action attached' });
      continue;
    }
    try {
      const outcome = await executeSocialAction(action, { ctx });
      results.push({ postId: post.id, outcome: 'status' in outcome && outcome.status === 'skipped' ? `skipped: ${outcome.reason}` : 'published' });
    } catch (err) {
      results.push({ postId: post.id, outcome: `failed: ${errorMessage(err)}` });
    }
  }
  return { status: 'completed', processed: results.length, results };
};

// ─────────────────────────────────────────────────────────────
// social.metrics
// ─────────────────────────────────────────────────────────────

export const socialMetrics: JobHandler<'social.metrics'> = async ({ payload, ctx }) => {
  const social = await loadSocial();
  if (!social) return skip(`Social metrics are unavailable in this deployment: ${socialLoadError ?? 'agent package missing'}.`);
  await ctx.updateProgress(20, 'Reading engagement from the platforms');
  const outcome = await social.refreshSocialMetrics(payload.websiteId, payload.lookbackDays ?? 14);
  if (outcome.checked === 0) return skip('No published posts with a platform id in the window.');
  return { status: 'completed', ...outcome };
};
