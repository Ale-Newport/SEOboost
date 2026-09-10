'use client';

import { ArrowRight, Bot, Radar, ScanSearch, ShieldCheck, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StepFooter, StepHeader } from './step-shell';

const CAPABILITIES = [
  {
    icon: ScanSearch,
    title: 'See the whole site',
    body: 'A crawl builds the page inventory, link graph and technical issue list every other screen reads from.',
  },
  {
    icon: Wrench,
    title: 'Fix what matters first',
    body: 'Issues, opportunities and content gaps are scored and ranked, and every score shows the factors behind it.',
  },
  {
    icon: Bot,
    title: 'Work with agents, on your terms',
    body: 'Agents propose changes; you choose how much they may do on their own, from insights-only to high autonomy.',
  },
];

const REQUIREMENTS = [
  'A domain this installation can reach over HTTP — that alone unlocks the technical audit, the link graph and content analysis.',
  'Google Search Console, connected later, for real clicks, impressions and positions instead of estimates.',
  'An AI provider key for the agents, content drafting and AI-search visibility. Everything else works without one.',
];

export function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div>
      <StepHeader
        icon={Radar}
        title="Welcome to SEO OS"
        description="Five minutes of setup, and most of it is optional. You can change every answer later."
      />

      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        {CAPABILITIES.map((item) => (
          <div key={item.title} className="rounded-md border border-border bg-muted/30 p-3.5">
            <item.icon className="size-4 text-primary" aria-hidden="true" />
            <p className="mt-2 text-sm font-medium leading-tight">{item.title}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.body}</p>
          </div>
        ))}
      </div>

      <div className="mt-6 space-y-2.5">
        <p className="text-sm font-medium">What it needs from you</p>
        <ul className="space-y-2">
          {REQUIREMENTS.map((requirement) => (
            <li key={requirement} className="flex gap-2.5 text-sm leading-relaxed text-muted-foreground">
              <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary/60" />
              <span>{requirement}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="mt-6 flex items-start gap-2.5 rounded-md border border-border bg-muted/30 p-3.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-muted-foreground">
          Screens only ever show data this installation actually holds. Where a metric needs an
          integration you have not connected, you will see what to configure — never an estimate
          standing in for the real number.
        </p>
      </div>

      <StepFooter>
        <Button onClick={onNext}>
          Get started
          <ArrowRight aria-hidden="true" />
        </Button>
      </StepFooter>
    </div>
  );
}
