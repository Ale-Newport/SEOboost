import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-2xs font-medium leading-4',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        success: 'border-success/25 bg-success/10 text-success',
        warning: 'border-warning/25 bg-warning/10 text-warning',
        destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
        info: 'border-info/25 bg-info/10 text-info',
        muted: 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ className, variant, ...props }, ref) {
  return <span ref={ref} className={cn(badgeVariants({ variant }), className)} {...props} />;
});

/** Issue severity, matching the `IssueSeverity` enum in the Prisma schema. */
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/**
 * Deliberate visual ramp — solid red, soft red, amber, blue, grey — so severity
 * is readable at a glance in a dense issue table without relying on hue alone
 * (the label is always present too).
 */
const SEVERITY_STYLES: Record<Severity, { className: string; label: string }> = {
  CRITICAL: { className: 'border-transparent bg-destructive text-destructive-foreground', label: 'Critical' },
  HIGH: { className: 'border-destructive/25 bg-destructive/10 text-destructive', label: 'High' },
  MEDIUM: { className: 'border-warning/25 bg-warning/10 text-warning', label: 'Medium' },
  LOW: { className: 'border-info/20 bg-info/10 text-info', label: 'Low' },
  INFO: { className: 'border-transparent bg-muted text-muted-foreground', label: 'Info' },
};

export interface SeverityBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  severity: Severity;
  /** Hide the leading dot in very dense layouts (tables with many badges). */
  hideDot?: boolean;
}

const SeverityBadge = React.forwardRef<HTMLSpanElement, SeverityBadgeProps>(function SeverityBadge(
  { severity, hideDot = false, className, ...props },
  ref,
) {
  const style = SEVERITY_STYLES[severity];
  return (
    <span ref={ref} className={cn(badgeVariants({ variant: 'outline' }), style.className, className)} {...props}>
      {hideDot ? null : <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current opacity-80" />}
      {style.label}
    </span>
  );
});

type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

/**
 * Tone for every status enum in the schema (crawls, actions, approvals,
 * integrations, drafts, experiments…). Unknown values fall back to `muted`
 * rather than throwing, so a new enum member never breaks a screen.
 */
const STATUS_TONE: Record<string, BadgeTone> = {
  ACTIVE: 'success',
  APPLIED: 'success',
  APPROVED: 'success',
  COMPLETED: 'success',
  CONNECTED: 'success',
  DEPLOYED: 'success',
  EVALUATED: 'success',
  LIKELY_POSITIVE: 'success',
  PUBLISHED: 'success',
  RESOLVED: 'success',
  VALID: 'success',

  AWAITING_APPROVAL: 'warning',
  INCONCLUSIVE: 'warning',
  PAUSED: 'warning',
  PENDING: 'warning',
  READY_FOR_APPROVAL: 'warning',
  REGRESSED: 'warning',
  ROLLED_BACK: 'warning',
  WARNING: 'warning',

  ERROR: 'destructive',
  EXPIRED: 'destructive',
  FAILED: 'destructive',
  INVALID: 'destructive',
  LIKELY_NEGATIVE: 'destructive',
  REJECTED: 'destructive',

  ACCEPTED: 'info',
  EXECUTING: 'info',
  IDENTIFIED: 'info',
  IN_PROGRESS: 'info',
  MEASURING: 'info',
  OPEN: 'info',
  PROPOSED: 'info',
  QUEUED: 'info',
  RUNNING: 'info',

  ABANDONED: 'muted',
  ARCHIVED: 'muted',
  CANCELLED: 'muted',
  DISABLED: 'muted',
  IGNORED: 'muted',
  NOT_CONFIGURED: 'muted',
  NOT_DEPLOYED: 'muted',
  NO_ACTION: 'muted',
  SKIPPED: 'muted',
  UNKNOWN: 'muted',
  UNVALIDATED: 'muted',
};

/** Statuses that represent work currently in flight — the dot pulses for these. */
const IN_FLIGHT = new Set(['RUNNING', 'EXECUTING', 'QUEUED', 'IN_PROGRESS', 'MEASURING']);

/** `SOME_ENUM_VALUE` → `Some enum value`. */
export function humanizeStatus(status: string): string {
  const words = status.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface StatusBadgeProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  status: string;
  /** Override the humanised enum label when the domain has a better word. */
  label?: string;
}

const StatusBadge = React.forwardRef<HTMLSpanElement, StatusBadgeProps>(function StatusBadge(
  { status, label, className, ...props },
  ref,
) {
  const key = status.toUpperCase();
  const tone = STATUS_TONE[key] ?? 'muted';
  const inFlight = IN_FLIGHT.has(key);

  return (
    <span ref={ref} className={cn(badgeVariants({ variant: tone }), className)} {...props}>
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0 rounded-full bg-current opacity-80', inFlight && 'motion-safe:animate-pulse')}
      />
      {label ?? humanizeStatus(status)}
    </span>
  );
});

export { Badge, SeverityBadge, StatusBadge };
