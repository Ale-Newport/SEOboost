'use client';

import * as React from 'react';
import Link from 'next/link';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';

interface ErrorPageProps {
  error: Error & { digest?: string };
  reset: () => void;
}

/**
 * Route-level error boundary.
 *
 * The thrown value is deliberately never rendered: in production it may carry a query, a
 * connection string or a provider response, and a user-facing page is the wrong place for any
 * of it. `digest` is a server-generated identifier that is safe to show and is what ties this
 * screen to the matching line in the server log. The full error goes to the browser console,
 * which developers see and end users do not read.
 */
export default function ErrorPage({ error, reset }: ErrorPageProps) {
  React.useEffect(() => {
    console.error('Unhandled error rendering route', error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md shadow-card">
        <CardHeader className="pb-3">
          <span className="mb-1 flex size-9 items-center justify-center rounded-md border border-destructive/25 bg-destructive/10 text-destructive">
            <TriangleAlert className="size-4" aria-hidden="true" />
          </span>
          <h1 className="text-base font-semibold leading-tight tracking-tight">Something went wrong</h1>
          <CardDescription>
            This screen failed to render. Nothing was changed, and retrying is safe.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-0">
          {error.digest ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Reference{' '}
              <code className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
                {error.digest}
              </code>{' '}
              — quote it when checking the server logs.
            </p>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Details were written to the server log.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => reset()}>
              <RefreshCw aria-hidden="true" />
              Try again
            </Button>
            <Button asChild variant="outline">
              <Link href="/">Back to dashboard</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
