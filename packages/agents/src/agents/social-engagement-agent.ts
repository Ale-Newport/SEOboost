import { ai, isAiAvailable, socialReplyDraftPrompt } from '@seo/ai';
import { json, prisma, type SocialConversation } from '@seo/db';
import { agentReachRead, agentReachStatus, canPublishWith, getPublisher } from '@seo/integrations';
import {
  evaluateReplyGuardrails,
  fitToPlatform,
  hasDisclosure,
  linksToDomain,
  mentionsAny,
  PLATFORM_TEXT_RULES,
  utmSourceFor,
  withUtm,
  type SocialPlatformName,
} from '@seo/seo-engine';
import { clamp, errorMessage, lexicalCosine, round, truncate } from '@seo/shared';
import { z } from 'zod';
import { registerAgent } from '../runtime/registry';
import type { AgentContext, AgentDefinition, AgentResult } from '../types';
import {
  ActionCollector,
  isRecord,
  loadVerifiedFacts,
  pluralise,
  propose,
  result,
  skipped,
  step,
  throwIfAborted,
  toPromptKnowledgeBase,
} from './shared';
import { accountSecrets, findCommunity, loadSocialContext, replyCounters, type SocialSiteContext } from './social-shared';

const AGENT = 'SocialEngagementAgent' as const;

/** At most this many drafts per run, whatever the daily cap allows: each one costs a human read. */
const MAX_DRAFTS_PER_RUN = 5;
/** Untriaged threads need at least this deterministic score to be drafted automatically. */
const AUTO_DRAFT_MIN_SCORE = 60;

const draftSchema = z.object({
  decision: z.enum(['REPLY', 'SKIP']),
  skipReason: z.string().nullable(),
  body: z.string(),
  mentionsProduct: z.boolean(),
  includesLink: z.boolean(),
  disclosureIncluded: z.boolean(),
  reviewerNotes: z.array(z.string()),
});

const inputSchema = z.object({
  /** Draft for exactly these conversations (the inbox's "Draft reply" button). */
  conversationIds: z.array(z.string()).optional(),
});

interface PageCandidate {
  url: string;
  title: string | null;
  summary: string | null;
  similarity: number;
}

/**
 * The page a reply could point to: the one whose title, H1 and description are lexically
 * closest to the thread. Lexical rather than embedding similarity keeps this free and
 * deterministic; the reviewer sees the choice and can change the URL before approving.
 */
async function bestPageFor(websiteId: string, text: string): Promise<PageCandidate | null> {
  const pages = await prisma.page.findMany({
    where: { websiteId, isIndexable: true, isActive: true, pageType: { notIn: ['LEGAL', 'CONTACT', 'AUTHOR'] } },
    orderBy: { clicks28d: 'desc' },
    take: 300,
    select: { url: true, title: true, h1: true, metaDescription: true },
  });
  let best: PageCandidate | null = null;
  for (const page of pages) {
    const similarity = lexicalCosine(text, [page.title, page.h1, page.metaDescription].filter(Boolean).join(' '));
    if (!best || similarity > best.similarity) {
      best = { url: page.url, title: page.title, summary: page.metaDescription, similarity };
    }
  }
  return best && best.similarity >= 0.08 ? best : null;
}

function triageOf(conversation: Pick<SocialConversation, 'triage'>): { fit: number | null; approach: string | null; angle: string | null } {
  const triage = isRecord(conversation.triage) ? conversation.triage : {};
  return {
    fit: typeof triage.fit === 'number' ? triage.fit : null,
    approach: typeof triage.approach === 'string' ? triage.approach : null,
    angle: typeof triage.angle === 'string' ? triage.angle : null,
  };
}

/** Remember why a thread was not drafted, so the inbox can say so instead of looking stuck. */
async function noteSkip(conversation: SocialConversation, reason: string): Promise<void> {
  const triage = isRecord(conversation.triage) ? conversation.triage : {};
  await prisma.socialConversation.update({
    where: { id: conversation.id },
    data: { triage: json({ ...triage, draftSkippedAt: new Date().toISOString(), draftSkipReason: reason }) },
  });
}

async function threadText(ctx: AgentContext, conversation: SocialConversation, useAgentReach: boolean): Promise<string> {
  const stored = [conversation.title, conversation.body].filter(Boolean).join('\n\n');
  if (!useAgentReach || (conversation.platform !== 'REDDIT' && conversation.platform !== 'X' && conversation.platform !== 'GITHUB')) {
    return stored;
  }
  try {
    const full = await step(ctx, 'read_thread', { url: conversation.url }, () => agentReachRead(conversation.url), (value) => ({
      chars: value?.length ?? 0,
    }));
    return full ?? stored;
  } catch (err) {
    ctx.log('full thread unavailable; using the stored excerpt', { error: errorMessage(err) });
    return stored;
  }
}

async function draftOne(
  ctx: AgentContext,
  social: SocialSiteContext,
  conversation: SocialConversation,
  collector: ActionCollector,
  facts: Awaited<ReturnType<typeof loadVerifiedFacts>>,
  useAgentReach: boolean,
): Promise<{ drafted: boolean; reason: string }> {
  const platform = conversation.platform as SocialPlatformName;
  const community = await findCommunity(ctx.websiteId, conversation.platform, conversation.community);
  const counters = await replyCounters({
    websiteId: ctx.websiteId,
    conversationId: conversation.id,
    community: conversation.community,
    countPending: true,
  });
  const baseGuard = {
    platform,
    conversation: { publishedAt: conversation.publishedAt, isLocked: conversation.isLocked },
    community: community
      ? { name: community.name, promotionPolicy: community.promotionPolicy, isBlocked: community.isBlocked }
      : null,
    alreadyEngaged: counters.alreadyEngaged,
    repliesToday: counters.repliesToday,
    dailyReplyLimit: social.limits.dailyReplyLimit,
    repliesInCommunityThisWeek: counters.repliesInCommunityThisWeek,
    promo: counters.promo,
    maxPromoRatio: social.limits.maxPromoRatio,
  };
  const pre = evaluateReplyGuardrails(baseGuard);
  if (!pre.allowed) {
    await noteSkip(conversation, pre.blockers.join(' '));
    return { drafted: false, reason: pre.blockers[0] ?? 'Guardrail' };
  }

  const triage = triageOf(conversation);
  const text = await threadText(ctx, conversation, useAgentReach);
  const page = pre.linkAllowed ? await bestPageFor(ctx.websiteId, text) : null;
  const utmLink = page
    ? withUtm(page.url, { source: utmSourceFor(platform), campaign: social.limits.utmCampaign, content: 'reply' })
    : null;

  const answer = await step(
    ctx,
    'draft_reply',
    { conversationId: conversation.id, platform, linkAllowed: pre.linkAllowed && Boolean(utmLink) },
    () =>
      ai.generateStructured({
        task: socialReplyDraftPrompt.id,
        websiteId: ctx.websiteId,
        agent: AGENT,
        role: socialReplyDraftPrompt.defaultRole ?? 'writing',
        system: socialReplyDraftPrompt.system,
        prompt: socialReplyDraftPrompt.render({
          platform,
          community: conversation.community,
          communityRulesSummary: community?.rulesSummary ?? null,
          threadTitle: conversation.title,
          threadText: text,
          threadUrl: conversation.url,
          intent: conversation.intent,
          angle: triage.angle,
          brandName: social.brandName,
          operatorDisclosure: social.limits.disclosure,
          suggestedLink: utmLink && page ? { url: utmLink, title: page.title, summary: page.summary } : null,
          linkAllowed: pre.linkAllowed && Boolean(utmLink),
          mentionAllowed: pre.mentionAllowed,
          maxLength: Math.min(PLATFORM_TEXT_RULES[platform].bodyLimit, 1_500),
          language: social.site.primaryLanguage,
          knowledgeBase: toPromptKnowledgeBase(social.site.knowledgeBase),
          brandFacts: facts,
        }),
        schema: draftSchema,
        schemaName: 'social_reply_draft',
        settings: social.site.settings,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
    (value) => ({ decision: value.data.decision }),
  );
  const draft = answer.data;
  if (draft.decision === 'SKIP' || !draft.body.trim()) {
    const reason = draft.skipReason ?? 'The drafter judged a reply would not be welcome or useful.';
    await noteSkip(conversation, reason);
    return { drafted: false, reason };
  }

  // The model's self-report is not trusted: what the text actually contains is re-derived here.
  const body = fitToPlatform(draft.body, platform).text;
  const includesLink = linksToDomain(body, social.domain);
  const mentionsBrand = mentionsAny(body, social.brandTerms);
  const disclosed = hasDisclosure(body, social.limits.disclosure);
  const post = evaluateReplyGuardrails({ ...baseGuard, draft: { body, includesLink, mentionsBrand, hasDisclosure: disclosed } });
  if (!post.allowed) {
    await noteSkip(conversation, `Draft refused by the guardrails: ${post.blockers.join(' ')}`);
    return { drafted: false, reason: post.blockers[0] ?? 'Guardrail' };
  }

  const account = await prisma.socialAccount.findFirst({
    where: { websiteId: ctx.websiteId, platform: conversation.platform, status: 'CONNECTED' },
  });
  const secrets = account ? accountSecrets(account) : null;
  const canPublish = Boolean(
    secrets && getPublisher(conversation.platform)?.capabilities.reply && canPublishWith(conversation.platform, secrets),
  );
  const socialPost = await prisma.socialPost.create({
    data: {
      websiteId: ctx.websiteId,
      accountId: account?.id ?? null,
      conversationId: conversation.id,
      kind: 'REPLY',
      platform: conversation.platform,
      status: 'DRAFT',
      community: conversation.community,
      body,
      linkUrl: includesLink ? utmLink : null,
      includesLink,
      disclosure: disclosed ? social.limits.disclosure : null,
      generatedBy: AGENT,
    },
    select: { id: true },
  });

  const fit = triage.fit ?? clamp(conversation.relevanceScore / 100);
  const created = await propose(ctx, collector, {
    type: 'SOCIAL_REPLY',
    title: truncate(`Reply on ${conversation.community ?? platform}: ${conversation.title ?? truncate(conversation.body ?? '', 80)}`, 200),
    reasoning:
      `${conversation.intent.replace(/-/g, ' ')} thread scored ${round(conversation.relevanceScore, 0)}/100` +
      `${triage.approach ? `; triage: ${triage.approach.replace(/_/g, ' ').toLowerCase()}` : ''}. ` +
      `${post.warnings.length ? `Check before approving: ${post.warnings.join(' ')} ` : ''}` +
      (canPublish
        ? 'Approving publishes this reply from the connected account.'
        : 'No connected account can reply on this platform: approving hands it to you to post by hand.'),
    evidence: {
      threadUrl: conversation.url,
      relevance: conversation.relevanceFactors,
      triage: conversation.triage,
      guard: { warnings: post.warnings, linkAllowed: post.linkAllowed, mentionAllowed: post.mentionAllowed },
      reviewerNotes: draft.reviewerNotes,
      counters,
    },
    affectedUrls: includesLink && page ? [page.url] : [],
    // `body` is a top-level string so the approval editor gives it a real text field.
    payload: {
      body,
      socialPostId: socialPost.id,
      platform: conversation.platform,
      community: conversation.community ?? '',
      threadUrl: conversation.url,
    },
    impact: clamp((conversation.relevanceScore / 100) * (0.5 + fit / 2)),
    confidence: clamp(fit),
    effort: 1,
    sourceType: 'social-conversation',
    sourceId: conversation.id,
    requiredAgent: AGENT,
    ...(canPublish ? {} : { advisory: 'Manual posting: no connected account with a reply API for this platform.' }),
  });

  if (!created) {
    // An open (or recently rejected) proposal already exists for this thread.
    await prisma.socialPost.delete({ where: { id: socialPost.id } });
    return { drafted: false, reason: 'A reply for this thread is already open or was rejected recently.' };
  }
  const actionId = collector.actionsCreated[collector.actionsCreated.length - 1] ?? null;
  await prisma.$transaction([
    prisma.socialPost.update({ where: { id: socialPost.id }, data: { status: 'AWAITING_APPROVAL', actionId } }),
    prisma.socialConversation.update({ where: { id: conversation.id }, data: { status: 'DRAFTED' } }),
  ]);
  return { drafted: true, reason: 'Drafted' };
}

async function run(ctx: AgentContext): Promise<AgentResult> {
  const input = inputSchema.parse(ctx.input ?? {});
  if (!isAiAvailable()) {
    return skipped(
      'No AI provider configured.',
      'Drafting replies needs an AI provider (ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_AI_API_KEY). Listening and scoring still work without one.',
    );
  }
  const social = await loadSocialContext(ctx.websiteId);

  const conversations = await prisma.socialConversation.findMany({
    where: input.conversationIds?.length
      ? { websiteId: ctx.websiteId, id: { in: input.conversationIds }, status: { notIn: ['REPLIED', 'DISMISSED', 'EXPIRED'] } }
      : {
          websiteId: ctx.websiteId,
          OR: [{ status: 'SHORTLISTED' }, { status: 'NEW', relevanceScore: { gte: AUTO_DRAFT_MIN_SCORE } }],
        },
    orderBy: { relevanceScore: 'desc' },
    take: 25,
  });
  // Untriaged-but-high-scoring threads are drafted; ones triage said to skip are not.
  const candidates = conversations
    .filter((conversation) => input.conversationIds?.length || triageOf(conversation).approach !== 'SKIP')
    .slice(0, MAX_DRAFTS_PER_RUN);
  if (candidates.length === 0) {
    return skipped(
      'Nothing to draft.',
      'No shortlisted conversations. Run social listening first, or pick a thread in the Social inbox and choose "Draft reply".',
    );
  }

  const [facts, reach] = await Promise.all([loadVerifiedFacts(ctx.websiteId), agentReachStatus()]);
  const collector = new ActionCollector();
  const outcomes: Array<{ conversationId: string; drafted: boolean; reason: string }> = [];
  for (const conversation of candidates) {
    throwIfAborted(ctx);
    try {
      const outcome = await draftOne(ctx, social, conversation, collector, facts, reach.available);
      outcomes.push({ conversationId: conversation.id, ...outcome });
      // The daily cap is global: once a guardrail says the cap is reached, stop asking.
      if (!outcome.drafted && /cap reached/i.test(outcome.reason)) break;
    } catch (err) {
      outcomes.push({ conversationId: conversation.id, drafted: false, reason: errorMessage(err) });
    }
  }

  const drafted = outcomes.filter((outcome) => outcome.drafted).length;
  return result({
    summary:
      `Drafted ${drafted} ${pluralise(drafted, 'reply', 'replies')} for review out of ${candidates.length} ${pluralise(candidates.length, 'candidate')}. ` +
      'Every reply waits in Approvals — replies in other communities are never posted automatically.',
    confidence: drafted > 0 ? 0.65 : 0.5,
    actionsCreated: collector.actionsCreated,
    approvalsCreated: collector.approvalsCreated,
    findings: outcomes.map((outcome) => ({ kind: outcome.drafted ? 'reply-drafted' : 'reply-skipped', ...outcome })),
    data: { drafted, candidates: candidates.length, outcomes },
  });
}

export const socialEngagementAgent: AgentDefinition = {
  name: AGENT,
  label: 'Social replies',
  description:
    'Drafts one helpful, disclosed reply per shortlisted conversation, checked against community rules and anti-spam caps, and sends each to Approvals. Never posts on its own.',
  allowedActionTypes: ['SOCIAL_REPLY'],
  tools: ['read_thread', 'draft_reply'],
  requiresAi: true,
  inputSchema,
  run,
};

registerAgent(socialEngagementAgent);
