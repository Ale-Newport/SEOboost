import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleAlert, CircleCheck, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

const alertVariants = cva(
  'relative grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 rounded-md border px-3.5 py-3 text-sm',
  {
    variants: {
      variant: {
        info: 'border-info/25 bg-info/[0.07] text-foreground [&>svg]:text-info',
        success: 'border-success/25 bg-success/[0.07] text-foreground [&>svg]:text-success',
        warning: 'border-warning/30 bg-warning/[0.08] text-foreground [&>svg]:text-warning',
        destructive: 'border-destructive/30 bg-destructive/[0.07] text-foreground [&>svg]:text-destructive',
        neutral: 'border-border bg-muted/40 text-foreground [&>svg]:text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'info',
    },
  },
);

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>['variant']>;

const DEFAULT_ICON: Record<AlertVariant, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  destructive: CircleAlert,
  neutral: Info,
};

export interface AlertProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  /** Replace the variant's default icon; pass `null` to drop it entirely. */
  icon?: LucideIcon | null;
}

/**
 * Warnings and errors get `role="alert"` so assistive tech interrupts with them;
 * informational variants stay silent to avoid announcing decorative copy.
 */
const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
  { className, variant, icon, children, ...props },
  ref,
) {
  const resolvedVariant: AlertVariant = variant ?? 'info';
  const Icon = icon === null ? null : (icon ?? DEFAULT_ICON[resolvedVariant]);
  const assertive = resolvedVariant === 'destructive' || resolvedVariant === 'warning';

  return (
    <div
      ref={ref}
      role={assertive ? 'alert' : undefined}
      className={cn(alertVariants({ variant: resolvedVariant }), className)}
      {...props}
    >
      {Icon ? <Icon className="size-4 shrink-0 translate-y-px" aria-hidden="true" /> : null}
      <div className={cn('space-y-1', Icon ? undefined : 'col-span-2')}>{children}</div>
    </div>
  );
});

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function AlertTitle({ className, ...props }, ref) {
    return <p ref={ref} className={cn('text-sm font-semibold leading-tight', className)} {...props} />;
  },
);

const AlertDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function AlertDescription({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn('text-sm leading-relaxed text-muted-foreground [&_a]:font-medium [&_a]:underline', className)}
        {...props}
      />
    );
  },
);

export { Alert, AlertTitle, AlertDescription, alertVariants };
