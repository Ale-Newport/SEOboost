import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { SimpleTooltip } from '@/components/ui/tooltip';

/**
 * The risk band of an action or approval.
 *
 * The bands come from `ACTION_RISK_BY_TYPE` in the engine and decide what may run unattended, so
 * the badge carries the definition with it: a colour alone does not tell an operator why a
 * redirect is HIGH and a meta description is SAFE.
 */

export type RiskBand = 'SAFE' | 'MEDIUM' | 'HIGH';

const RISK: Record<RiskBand, { variant: 'success' | 'warning' | 'destructive'; label: string; hint: string }> = {
  SAFE: {
    variant: 'success',
    label: 'Safe',
    hint: 'Reversible and low-consequence. These can run unattended at higher autonomy levels and are the only ones bulk approval ever touches.',
  },
  MEDIUM: {
    variant: 'warning',
    label: 'Medium',
    hint: 'Changes live copy or markup. Reversible, but it moves rankings — worth reading the diff before approving.',
  },
  HIGH: {
    variant: 'destructive',
    label: 'High',
    hint: 'Redirects, consolidations and custom changes. Hard or impossible to undo automatically, and never bulk-approved at any autonomy level.',
  },
};

export interface RiskBadgeProps {
  risk: string;
  className?: string;
}

export function RiskBadge({ risk, className }: RiskBadgeProps): React.JSX.Element {
  const band = RISK[risk as RiskBand];
  if (!band) {
    return (
      <Badge variant="muted" className={className}>
        {risk}
      </Badge>
    );
  }

  return (
    <SimpleTooltip content={band.hint}>
      <Badge variant={band.variant} className={className} tabIndex={0}>
        {band.label} risk
      </Badge>
    </SimpleTooltip>
  );
}

/** Order the approval queue groups run in: the decisions that matter most, first. */
export const RISK_ORDER: readonly RiskBand[] = ['HIGH', 'MEDIUM', 'SAFE'];

export function riskLabel(risk: string): string {
  return RISK[risk as RiskBand]?.label ?? risk;
}
