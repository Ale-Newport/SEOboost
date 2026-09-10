import { ActionRisk, ActionStatus, ActionType, IssueStatus, json, prisma } from '@seo/db';
import { ConflictError, NotFoundError, createLogger, round } from '@seo/shared';
import {
  RULE_LIST,
  calculatePriority,
  riskBandForActionType,
  riskLevelForActionType,
  type RuleDefinition,
} from '@seo/seo-engine';
import { requireWebsite, route } from '@/lib/api';

const log = createLogger('api:issue-fix');

type Params = { id: string; issueId: string };

/** Rule metadata by id. Built once per process — the catalogue is static. */
const RULES_BY_ID = new Map<string, RuleDefinition>(RULE_LIST.map((rule) => [rule.id, rule]));

/**
 * Statuses in which an existing action still represents this issue.
 * A rejected or cancelled attempt is finished business, so a fresh proposal is allowed.
 */
const LIVE_ACTION_STATUSES: ActionStatus[] = [
  ActionStatus.PROPOSED,
  ActionStatus.QUEUED,
  ActionStatus.AWAITING_APPROVAL,
  ActionStatus.APPROVED,
  ActionStatus.EXECUTING,
  ActionStatus.COMPLETED,
  ActionStatus.MEASURING,
  ActionStatus.EVALUATED,
];

/**
 * `POST /api/websites/[id]/issues/[issueId]/fix` — raise a fix action for one technical issue.
 *
 * The action is created as PROPOSED, never approved and never executed here: turning a finding
 * into a change to someone's live site is a decision, and it belongs to the approval queue.
 * Priority is computed with the shared `calculatePriority` formula from the issue's own recorded
 * impact and confidence, and every input is stored in `priorityFactors` so the number stays
 * inspectable rather than becoming a bare score.
 */
export const POST = route<Params>(async ({ user, params }) => {
  const website = await requireWebsite(user.id, params.id);

  const issue = await prisma.technicalIssue.findFirst({
    where: { id: params.issueId, websiteId: website.id },
    select: {
      id: true,
      ruleId: true,
      title: true,
      severity: true,
      category: true,
      status: true,
      url: true,
      description: true,
      recommendation: true,
      evidence: true,
      estimatedImpact: true,
      confidence: true,
      autoFixable: true,
      page: { select: { url: true } },
    },
  });
  if (!issue) throw new NotFoundError('Issue');

  const existing = await prisma.seoAction.findFirst({
    where: {
      websiteId: website.id,
      sourceType: 'technical-issue',
      sourceId: issue.id,
      status: { in: LIVE_ACTION_STATUSES },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  });
  if (existing) {
    throw new ConflictError(
      `A fix action for this issue already exists and is ${existing.status.toLowerCase()}.`,
    );
  }

  const rule = RULES_BY_ID.get(issue.ruleId) ?? null;
  const targetUrl = issue.url ?? issue.page?.url ?? null;

  // Effort is derived, not guessed: an auto-fixable rule is one the platform can apply itself,
  // which is the definition of trivial effort. Anything else needs a person, so it is moderate.
  const effort = issue.autoFixable ? 1 : 3;
  const risk = riskLevelForActionType(ActionType.FIX_TECHNICAL_ISSUE);
  // No per-issue business value is measured anywhere, so this stays at the schema's neutral
  // prior rather than inventing a number. It is reported in `priorityFactors` as exactly that.
  const businessValue = 0.5;

  const priority = calculatePriority({
    impact: issue.estimatedImpact,
    confidence: issue.confidence,
    businessValue,
    effort,
    risk,
  });

  const reasoning = [
    rule?.rationale ?? issue.description,
    issue.recommendation,
    `Raised from technical issue ${issue.ruleId}${targetUrl ? ` on ${targetUrl}` : ' (site-wide)'}.`,
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  const [action] = await prisma.$transaction([
    prisma.seoAction.create({
      data: {
        websiteId: website.id,
        type: ActionType.FIX_TECHNICAL_ISSUE,
        title: `Fix: ${issue.title}`,
        status: ActionStatus.PROPOSED,
        risk: ActionRisk[riskBandForActionType(ActionType.FIX_TECHNICAL_ISSUE)],
        reasoning,
        evidence: json({
          issueId: issue.id,
          ruleId: issue.ruleId,
          severity: issue.severity,
          category: issue.category,
          description: issue.description,
          ruleEvidence: issue.evidence,
          raisedBy: user.email,
        }),
        affectedUrls: targetUrl ? [targetUrl] : [],
        payload: json({ issueId: issue.id, ruleId: issue.ruleId, url: targetUrl }),
        impactScore: round(issue.estimatedImpact, 2),
        effortScore: effort,
        confidenceScore: round(issue.confidence, 2),
        businessValue,
        riskScore: risk,
        priorityScore: priority.score,
        priorityFactors: json({
          summary: priority.summary,
          factors: priority.factors,
          notes: {
            effort: issue.autoFixable
              ? 'Effort 1/5: the rule is marked auto-fixable, so the platform can apply the change.'
              : 'Effort 3/5: this rule has no automated fix, so a person has to make the change.',
            businessValue:
              'Business relevance is the neutral 0.5 prior — nothing measures per-issue revenue impact.',
          },
        }),
        sourceType: 'technical-issue',
        sourceId: issue.id,
        autoExecutable: false,
      },
      select: { id: true, title: true, status: true, priorityScore: true, risk: true },
    }),
    // Mark the finding as being worked on, so it stops competing for attention in the open list.
    prisma.technicalIssue.update({
      where: { id: issue.id },
      data: { status: IssueStatus.IN_PROGRESS, ignoredAt: null, ignoredReason: null, resolvedAt: null },
    }),
  ]);

  log.info('fix action proposed from issue', {
    websiteId: website.id,
    issueId: issue.id,
    ruleId: issue.ruleId,
    actionId: action.id,
  });

  return {
    action,
    issue: { id: issue.id, status: IssueStatus.IN_PROGRESS },
    nextStep: 'Review and approve the action in the action queue before it can run.',
  };
});
