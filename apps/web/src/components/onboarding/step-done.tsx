'use client';

import Link from 'next/link';
import { ArrowRight, Bot, LayoutDashboard, Rocket, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StepHeader } from './step-shell';
import type { OnboardingWebsite } from './types';

interface StepDoneProps {
  site: OnboardingWebsite;
}

export function StepDone({ site }: StepDoneProps) {
  const base = `/sites/${site.id}`;

  return (
    <div>
      <StepHeader
        icon={Rocket}
        title={`${site.name} is set up`}
        description="Analysis runs as soon as the crawl completes. Two places worth opening first:"
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        <Link
          href={`${base}/technical`}
          className="group rounded-md border border-border bg-muted/30 p-4 transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Wrench className="size-4 text-primary" aria-hidden="true" />
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium leading-tight">
            Technical audit
            <ArrowRight
              className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Every issue found in the crawl, ranked by severity, with the pages each one affects.
          </p>
        </Link>

        <Link
          href={`${base}/strategy`}
          className="group rounded-md border border-border bg-muted/30 p-4 transition-colors hover:border-primary/40 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Bot className="size-4 text-primary" aria-hidden="true" />
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium leading-tight">
            AI SEO Manager
            <ArrowRight
              className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The plan for this site — what to do today, this week and this month, and why.
          </p>
        </Link>
      </div>

      <div className="mt-6 rounded-md border border-border bg-muted/30 p-4">
        <p className="text-sm font-medium">Worth doing next</p>
        <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
          <li>
            Set the autonomy level in{' '}
            <Link href={`${base}/settings`} className="font-medium text-primary underline-offset-4 hover:underline">
              this site&rsquo;s settings
            </Link>{' '}
            — it decides what agents may do without your approval.
          </li>
          <li>
            Connect any integration you skipped from{' '}
            <Link href="/settings" className="font-medium text-primary underline-offset-4 hover:underline">
              Settings
            </Link>
            .
          </li>
          <li>Add the rest of your portfolio once this site looks right.</li>
        </ul>
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-2 border-t border-border pt-5">
        <Button asChild>
          <Link href={base}>
            Open {site.name}
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/">
            <LayoutDashboard aria-hidden="true" />
            Portfolio dashboard
          </Link>
        </Button>
      </div>
    </div>
  );
}
