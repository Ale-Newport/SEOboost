import type { Metadata } from 'next';
import Link from 'next/link';
import { Compass, Globe, LayoutDashboard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';

export const metadata: Metadata = { title: 'Page not found' };

/**
 * 404.
 *
 * Rendered outside the authenticated shell (an unknown path has no site context), so it
 * carries its own way back rather than assuming a sidebar is present.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-16">
      <Card className="w-full max-w-md shadow-card">
        <CardHeader className="pb-3">
          <span className="mb-1 flex size-9 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground">
            <Compass className="size-4" aria-hidden="true" />
          </span>
          <h1 className="text-base font-semibold leading-tight tracking-tight">
            <span className="tabular mr-2 text-muted-foreground">404</span>
            Page not found
          </h1>
          <CardDescription>
            That URL does not match any screen in this installation. It may have been renamed, or
            the record it pointed at was deleted.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-0">
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/">
                <LayoutDashboard aria-hidden="true" />
                Dashboard
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/sites">
                <Globe aria-hidden="true" />
                Your sites
              </Link>
            </Button>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Looking for a specific page, keyword or issue? Press{' '}
            <kbd className="rounded border border-border bg-muted px-1 py-0.5 font-sans text-2xs text-foreground">
              ⌘K
            </kbd>{' '}
            anywhere in the app to search.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
