import * as React from 'react';

import { cn } from '@/lib/utils';

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Breadcrumb trail rendered above the title — pass a `<nav aria-label="Breadcrumb">`. */
  breadcrumb?: React.ReactNode;
  /** Primary and secondary buttons, right-aligned on wide viewports. */
  actions?: React.ReactNode;
  /** Keeps the title and actions in reach while a long table scrolls. */
  sticky?: boolean;
  /** Hairline under the header; implied by `sticky`, which needs the separation. */
  bordered?: boolean;
  /**
   * `1` on a page root, `2` when the header introduces a nested view that
   * already sits under an `<h1>` — the outline has to stay honest.
   */
  headingLevel?: 1 | 2;
}

/**
 * Page-level title block. Sticky mode uses a translucent background with a blur
 * rather than a solid fill so scrolled content stays faintly visible behind it,
 * which keeps the dense tables underneath from feeling clipped.
 */
const PageHeader = React.forwardRef<HTMLElement, PageHeaderProps>(function PageHeader(
  { title, description, breadcrumb, actions, sticky = false, bordered = false, headingLevel = 1, className, ...props },
  ref,
) {
  const Heading = headingLevel === 1 ? 'h1' : 'h2';

  return (
    <header
      ref={ref}
      className={cn(
        'flex flex-col gap-3 pb-4',
        (bordered || sticky) && 'border-b border-border',
        sticky && 'sticky top-0 z-30 bg-background/85 pt-4 backdrop-blur supports-[backdrop-filter]:bg-background/70',
        className,
      )}
      {...props}
    >
      {breadcrumb ? <div className="min-w-0">{breadcrumb}</div> : null}

      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 space-y-1">
          <Heading className="truncate text-lg font-semibold leading-tight tracking-tight text-foreground">
            {title}
          </Heading>
          {description ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
});

export { PageHeader };
