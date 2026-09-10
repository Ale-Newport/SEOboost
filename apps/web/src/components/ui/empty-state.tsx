import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Inbox, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

const emptyStateVariants = cva('flex flex-col items-center justify-center text-center', {
  variants: {
    size: {
      /** Fits inside a card body or a table's empty row. */
      sm: 'gap-2 px-4 py-8',
      default: 'gap-3 px-6 py-14',
      lg: 'gap-3 px-6 py-24',
    },
    bordered: {
      true: 'rounded-lg border border-dashed border-border bg-card/40',
      false: '',
    },
  },
  defaultVariants: {
    size: 'default',
    bordered: false,
  },
});

export interface EmptyStateProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof emptyStateVariants> {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Primary call to action — usually a `<Button>`. */
  action?: React.ReactNode;
  /** Secondary escape hatch, e.g. "Read the docs". */
  secondaryAction?: React.ReactNode;
}

/**
 * The canonical "there is nothing here" surface. Absence of data is a real
 * result in this product (no crawl yet, no integration connected), so it gets a
 * first-class component rather than a blank panel.
 */
const EmptyState = React.forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { icon: Icon = Inbox, title, description, action, secondaryAction, size, bordered, className, ...props },
  ref,
) {
  return (
    <div ref={ref} className={cn(emptyStateVariants({ size, bordered }), className)} {...props}>
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-full border border-border bg-muted/60 text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action || secondaryAction ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
});

export { EmptyState, emptyStateVariants };
