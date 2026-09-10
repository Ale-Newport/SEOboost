import type { ApprovalDiffEntryView } from './diff-view';

/**
 * Serialisable shapes the approvals screen hands to its client components.
 *
 * The Prisma enums never cross the server/client boundary — importing `@seo/db` from a
 * `'use client'` module drags the generated client into the browser bundle — so the three
 * enums this screen needs are mirrored as string unions and narrowed once, on the server.
 */

export const APPROVAL_RISKS = ['HIGH', 'MEDIUM', 'SAFE'] as const;
export type ApprovalRiskValue = (typeof APPROVAL_RISKS)[number];

export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED'] as const;
export type ApprovalStatusValue = (typeof APPROVAL_STATUSES)[number];

export function toApprovalRisk(value: string): ApprovalRiskValue {
  return (APPROVAL_RISKS as readonly string[]).includes(value) ? (value as ApprovalRiskValue) : 'HIGH';
}

export function toApprovalStatus(value: string): ApprovalStatusValue {
  return (APPROVAL_STATUSES as readonly string[]).includes(value)
    ? (value as ApprovalStatusValue)
    : 'PENDING';
}

/** The action an approval gates, when it gates one. Standalone approvals have no action. */
export interface ApprovalActionSummary {
  id: string;
  type: string;
  status: string;
  risk: ApprovalRiskValue;
  /** Why the agent proposed this. Always written by the agent — never generated here. */
  reasoning: string;
  affectedUrls: string[];
  priorityScore: number;
}

export interface ApprovalItem {
  id: string;
  websiteId: string;
  websiteName: string;
  websiteDomain: string;
  actionId: string | null;
  action: ApprovalActionSummary | null;
  kind: string;
  title: string;
  description: string | null;
  risk: ApprovalRiskValue;
  status: ApprovalStatusValue;
  /** Normalised field diff. Empty when the agent wrote its diff in another shape. */
  diff: ApprovalDiffEntryView[];
  /** The raw diff JSON, rendered verbatim when the normaliser did not recognise it. */
  rawDiff: unknown;
  payload: Record<string, unknown>;
  /** Set once an operator edited the proposal before deciding. */
  editedPayload: Record<string, unknown> | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedBy: string | null;
  createdAt: string;
  /**
   * True when this action type may never be approved in bulk (`ALWAYS_REQUIRES_APPROVAL`).
   * The server enforces it; the queue reads it so the bulk control can never even offer it.
   */
  requiresIndividualDecision: boolean;
}

/** Counts for one risk band, computed server-side across the whole owned portfolio. */
export interface ApprovalRiskCount {
  risk: ApprovalRiskValue;
  count: number;
}
