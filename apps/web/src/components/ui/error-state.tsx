'use client';

import * as React from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from './button';

export interface ErrorStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  /** What went wrong, in the user's language. */
  message: React.ReactNode;
  /** Raw diagnostics (stack, provider response) hidden behind a disclosure. */
  details?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** True while a retry is in flight, so the button can show its spinner. */
  retrying?: boolean;
  bordered?: boolean;
}

/**
 * Failure surface for any panel that loads data. Details stay collapsed so a
 * provider stack trace never becomes the loudest thing on the screen, but the
 * operator can still get at it without opening devtools.
 */
const ErrorState = React.forwardRef<HTMLDivElement, ErrorStateProps>(function ErrorState(
  {
    title = 'Something went wrong',
    message,
    details,
    onRetry,
    retryLabel = 'Try again',
    retrying = false,
    bordered = true,
    className,
    ...props
  },
  ref,
) {
  return (
    <div
      ref={ref}
      role="alert"
      className={cn(
        'flex flex-col items-center gap-3 px-6 py-10 text-center',
        bordered && 'rounded-lg border border-destructive/25 bg-destructive/[0.05]',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="flex size-9 items-center justify-center rounded-full bg-destructive/10 text-destructive"
      >
        <TriangleAlert className="size-4" />
      </span>

      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mx-auto max-w-md text-sm leading-relaxed text-muted-foreground">{message}</p>
      </div>

      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry} loading={retrying} loadingText="Retrying">
          {retrying ? null : <RefreshCw aria-hidden="true" />}
          {retryLabel}
        </Button>
      ) : null}

      {details ? (
        <details className="w-full max-w-xl text-left">
          <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            Technical details
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 font-mono text-2xs leading-relaxed text-muted-foreground">
            {details}
          </pre>
        </details>
      ) : null}
    </div>
  );
});

export { ErrorState };
