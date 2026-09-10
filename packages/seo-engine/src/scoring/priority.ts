import { ALWAYS_REQUIRES_APPROVAL, ACTION_RISK_BY_TYPE, clamp, round, type ExplainableScore, type ScoreFactor } from '@seo/shared';

export interface PriorityInput {
  /** 0-1 expected benefit if the action works. */
  impact: number;
  /** 0-1 how confident the platform is that it will work. */
  confidence: number;
  /** 0-1 relevance to the site's stated business goal. */
  businessValue: number;
  /** 1-5, where 1 is trivial. */
  effort: number;
  /** 1-5, where 1 is fully reversible and safe. */
  risk: number;
  /** Historical success rate of this action type on this site, if known (0-1). */
  historicalSuccessRate?: number | null;
  historicalSampleSize?: number;
}

/**
 * Action priority score, 0-100.
 *
 * PriorityScore = (Impact × Confidence × BusinessValue) / (Effort × Risk), normalised.
 *
 * The raw ratio ranges from 0 (useless) to 1 (perfect, effortless, riskless), because effort and
 * risk are both ≥1. We then apply a mild Bayesian adjustment from the site's own history: if
 * "update title" actions on this site have historically not moved the needle, similar proposals
 * are damped. This is the feedback loop feeding back into prioritisation.
 */
export function calculatePriority(input: PriorityInput): ExplainableScore {
  const impact = clamp(input.impact);
  const confidence = clamp(input.confidence);
  const businessValue = clamp(input.businessValue);
  const effort = Math.min(5, Math.max(1, input.effort));
  const risk = Math.min(5, Math.max(1, input.risk));

  const numerator = impact * confidence * businessValue;
  const denominator = effort * risk;
  const raw = numerator / denominator;

  // A perfect action (impact 1, confidence 1, value 1, effort 1, risk 1) yields raw = 1.
  // Realistic strong actions land around 0.3-0.5, so a sqrt curve spreads the useful range
  // across the 0-100 scale instead of squashing everything under 50.
  let normalised = Math.sqrt(raw);

  const factors: ScoreFactor[] = [
    {
      key: 'impact', label: 'Expected impact', value: impact, weight: 0.35,
      contribution: round(impact * 35, 1),
      explanation: `${Math.round(impact * 100)}% expected benefit if this works.`,
    },
    {
      key: 'confidence', label: 'Confidence', value: confidence, weight: 0.25,
      contribution: round(confidence * 25, 1),
      explanation: `${Math.round(confidence * 100)}% confidence in the diagnosis and the fix.`,
    },
    {
      key: 'businessValue', label: 'Business relevance', value: businessValue, weight: 0.2,
      contribution: round(businessValue * 20, 1),
      explanation: `${Math.round(businessValue * 100)}% aligned with the site's conversion goal.`,
    },
    {
      key: 'effort', label: 'Effort', value: 1 - (effort - 1) / 4, weight: 0.12,
      contribution: round((1 - (effort - 1) / 4) * 12, 1),
      explanation: `Effort ${effort}/5 (${['trivial', 'low', 'moderate', 'high', 'very high'][effort - 1]}).`,
    },
    {
      key: 'risk', label: 'Safety', value: 1 - (risk - 1) / 4, weight: 0.08,
      contribution: round((1 - (risk - 1) / 4) * 8, 1),
      explanation: `Risk ${risk}/5 (${['fully reversible', 'low', 'moderate', 'high', 'destructive'][risk - 1]}).`,
    },
  ];

  let historyNote = '';
  if (input.historicalSuccessRate !== null && input.historicalSuccessRate !== undefined) {
    const n = input.historicalSampleSize ?? 0;
    // Shrink toward the prior (0.5) when the sample is small — 5 observations gives half weight.
    const shrunk = (input.historicalSuccessRate * n + 0.5 * 5) / (n + 5);
    const multiplier = 0.75 + shrunk * 0.5; // 0.75x … 1.25x
    normalised = clamp(normalised * multiplier);
    historyNote = ` Adjusted by past results on this site: ${Math.round(input.historicalSuccessRate * 100)}% of similar actions helped (n=${n}).`;
    factors.push({
      key: 'history', label: 'Past results', value: shrunk, weight: 0,
      contribution: 0,
      explanation: `Applied a ${multiplier.toFixed(2)}× adjustment from ${n} previous comparable action${n === 1 ? '' : 's'}.`,
    });
  }

  const score = round(clamp(normalised) * 100, 1);
  return {
    score,
    factors,
    summary:
      `Impact ${Math.round(impact * 100)}% × confidence ${Math.round(confidence * 100)}% × business value ` +
      `${Math.round(businessValue * 100)}% ÷ (effort ${effort} × risk ${risk}).${historyNote}`,
  };
}

export type ActionTypeName = keyof typeof ACTION_RISK_BY_TYPE;

/** Map the declared risk band of an action type onto the 1-5 risk scale used by the formula. */
export function riskLevelForActionType(type: string): number {
  const band = ACTION_RISK_BY_TYPE[type as ActionTypeName] ?? 'HIGH';
  return band === 'SAFE' ? 1 : band === 'MEDIUM' ? 2.5 : 4;
}

export function riskBandForActionType(type: string): 'SAFE' | 'MEDIUM' | 'HIGH' {
  return (ACTION_RISK_BY_TYPE[type as ActionTypeName] ?? 'HIGH') as 'SAFE' | 'MEDIUM' | 'HIGH';
}

/**
 * The single guardrail that decides whether an action may execute without a human.
 * Called by both the UI and the worker — never bypass it.
 */
export function canAutoExecute(params: {
  actionType: string;
  autonomyLevel: string;
  autoApproveSafe: boolean;
}): { allowed: boolean; reason: string } {
  const { actionType, autonomyLevel } = params;

  if ((ALWAYS_REQUIRES_APPROVAL as readonly string[]).includes(actionType)) {
    return {
      allowed: false,
      reason: `${actionType} always requires explicit human approval, regardless of autonomy level.`,
    };
  }

  const allowedByLevel: Record<string, readonly string[]> = {
    L0_INSIGHTS_ONLY: [],
    L1_DRAFTS_ONLY: [],
    L2_SAFE_TECHNICAL: ['ADD_STRUCTURED_DATA', 'SUBMIT_URL_INDEXING', 'UPDATE_META_DESCRIPTION'],
    L3_MOST_REVERSIBLE: [
      'ADD_STRUCTURED_DATA', 'SUBMIT_URL_INDEXING', 'UPDATE_META_DESCRIPTION',
      'ADD_INTERNAL_LINKS', 'UPDATE_TITLE', 'FIX_TECHNICAL_ISSUE', 'CREATE_CONTENT_BRIEF',
    ],
    L4_HIGH_AUTONOMY: [
      'ADD_STRUCTURED_DATA', 'SUBMIT_URL_INDEXING', 'UPDATE_META_DESCRIPTION',
      'ADD_INTERNAL_LINKS', 'UPDATE_TITLE', 'FIX_TECHNICAL_ISSUE', 'CREATE_CONTENT_BRIEF',
      'UPDATE_CONTENT', 'PUBLISH_CONTENT', 'REFRESH_CONTENT', 'GEO_IMPROVEMENT', 'OUTREACH_DRAFT',
    ],
  };

  const allowed = allowedByLevel[autonomyLevel] ?? [];
  if (allowed.includes(actionType)) {
    return { allowed: true, reason: `Autonomy ${autonomyLevel} permits ${actionType} without approval.` };
  }

  if (params.autoApproveSafe && riskBandForActionType(actionType) === 'SAFE') {
    return { allowed: true, reason: 'Action is classified SAFE and "auto-approve safe actions" is enabled.' };
  }

  return {
    allowed: false,
    reason: `Autonomy level ${autonomyLevel} requires approval for ${actionType}.`,
  };
}
