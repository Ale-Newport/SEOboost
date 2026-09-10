import * as React from 'react';

import { cn } from '@/lib/utils';

const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function Card(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('rounded-lg border border-border bg-card text-card-foreground shadow-xs', className)}
      {...props}
    />
  );
});

/**
 * Two-column grid so `CardAction` can sit flush top-right of the header
 * without the title/description needing to know it exists.
 */
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardHeader(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('grid auto-rows-min grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 p-5', className)}
      {...props}
    />
  );
});

const CardTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(function CardTitle(
  { className, ...props },
  ref,
) {
  return <h3 ref={ref} className={cn('text-sm font-semibold leading-tight tracking-tight', className)} {...props} />;
});

const CardDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  function CardDescription({ className, ...props }, ref) {
    return <p ref={ref} className={cn('text-sm leading-relaxed text-muted-foreground', className)} {...props} />;
  },
);

const CardAction = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardAction(
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

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardContent(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn('px-5 pb-5 pt-0 [&:first-child]:pt-5', className)} {...props} />;
});

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(function CardFooter(
  { className, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn('flex items-center gap-2 border-t border-border/70 px-5 py-3.5', className)}
      {...props}
    />
  );
});

export { Card, CardHeader, CardTitle, CardDescription, CardAction, CardContent, CardFooter };
