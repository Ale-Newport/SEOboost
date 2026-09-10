import { ShieldAlert, ShieldCheck, ShieldQuestion, type LucideIcon } from 'lucide-react';

import type { ApprovalRiskValue } from './types';

/**
 * How each risk band is presented.
 *
 * The band is the organising principle of the queue, so it carries a real explanation rather
 * than a colour: an operator has to know *why* a change is in the band it is in before the
 * band can mean anything to them.
 */

export type Tone = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'info' | 'muted';

export interface RiskMeta {
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /** Sentence shown at the top of the group. */
  description: string;
  /** Whether "Approve all safe" is allowed to touch this band. Only ever true for SAFE. */
  bulkApprovable: boolean;
}

export const RISK_META: Record<ApprovalRiskValue, RiskMeta> = {
  HIGH: {
    label: 'High risk',
    icon: ShieldAlert,
    tone: 'destructive',
    description:
      'These change how the site is crawled, indexed or routed. A mistake here is visible in search results and is not always cheap to undo — read the diff before deciding.',
    bulkApprovable: false,
  },
  MEDIUM: {
    label: 'Medium risk',
    icon: ShieldQuestion,
    tone: 'warning',
    description:
      'These rewrite copy that users and crawlers already see. Reversible, but they change what the page says — check the wording is yours.',
    bulkApprovable: false,
  },
  SAFE: {
    label: 'Safe',
    icon: ShieldCheck,
    tone: 'success',
    description:
      'Additive changes with no effect on routing or indexing — structured data, alt text, internal links. These are the only items "Approve all safe" will ever touch.',
    bulkApprovable: true,
  },
};

export function riskMeta(risk: string): RiskMeta {
  return RISK_META[risk as ApprovalRiskValue] ?? RISK_META.HIGH;
}

/** Display order for the queue: the decisions that need a human read come first. */
export const RISK_ORDER: readonly ApprovalRiskValue[] = ['HIGH', 'MEDIUM', 'SAFE'];

/** `UPDATE_META_DESCRIPTION` → `Update meta description`. */
export function humanizeKind(kind: string): string {
  const words = kind.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
