import * as React from 'react';

import { cn } from '@/lib/utils';

export interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  /**
   * Vertical rhythm between the header and the body. Every screen composes from
   * these three steps so unrelated pages still scan at the same cadence.
   */
  spacing?: 'sm' | 'md' | 'lg';
}

const SPACING: Record<NonNullable<SectionProps['spacing']>, string> = {
  sm: 'space-y-2',
  md: 'space-y-3',
  lg: 'space-y-5',
};

const Section = React.forwardRef<HTMLElement, SectionProps>(function Section(
  { spacing = 'md', className, ...props },
  ref,
) {
  return <section ref={ref} className={cn(SPACING[spacing], className)} {...props} />;
});

/**
 * Two-column grid, same shape as `CardHeader`: title and description flow down
 * the first column while `SectionActions` sits flush top-right, so neither slot
 * has to know whether the other is present.
 */
const SectionHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function SectionHeader(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('grid auto-rows-min grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-1', className)}
      {...props}
    />
  );
});

export interface SectionTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  /** Match the surrounding document outline; sections are usually `h2`. */
  as?: 'h2' | 'h3' | 'h4';
}

const SectionTitle = React.forwardRef<HTMLHeadingElement, SectionTitleProps>(function SectionTitle(
  { as: Heading = 'h2', className, ...props },
  ref,
) {
  return (
    <Heading
      ref={ref}
      className={cn('text-sm font-semibold leading-tight tracking-tight text-foreground', className)}
      {...props}
    />
  );
});

const SectionDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function SectionDescription({ className, ...props }, ref) {
    return <p ref={ref} className={cn('text-sm leading-relaxed text-muted-foreground', className)} {...props} />;
  },
);

/** Right-hand slot of a `SectionHeader` — filters, links, buttons. */
const SectionActions = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function SectionActions(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('col-start-2 row-start-1 row-end-3 flex items-center gap-2 self-start justify-self-end', className)}
      {...props}
    />
  );
});

const SectionBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function SectionBody(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn('min-w-0', className)} {...props} />;
});

export { Section, SectionHeader, SectionTitle, SectionDescription, SectionActions, SectionBody };
