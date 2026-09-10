'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import {
  Bot,
  Check,
  Globe,
  LineChart,
  Radar,
  Rocket,
  Store,
  Users,
  Waypoints,
  type LucideIcon,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { StepAiProvider } from './step-ai-provider';
import { StepBusiness } from './step-business';
import { StepCompetitors } from './step-competitors';
import { StepCrawl } from './step-crawl';
import { StepDone } from './step-done';
import { StepSearchConsole } from './step-search-console';
import { StepWebsite } from './step-website';
import { StepWelcome } from './step-welcome';
import type { AiProviderOption, GoogleSetup, OnboardingWebsite } from './types';

interface StepDefinition {
  id: number;
  label: string;
  icon: LucideIcon;
  /** Only the website step is mandatory; everything else can be filled in later. */
  optional: boolean;
}

const STEPS: StepDefinition[] = [
  { id: 1, label: 'Welcome', icon: Radar, optional: false },
  { id: 2, label: 'Website', icon: Globe, optional: false },
  { id: 3, label: 'Business', icon: Store, optional: true },
  { id: 4, label: 'Competitors', icon: Users, optional: true },
  { id: 5, label: 'Search Console', icon: LineChart, optional: true },
  { id: 6, label: 'AI provider', icon: Bot, optional: true },
  { id: 7, label: 'First crawl', icon: Waypoints, optional: true },
  { id: 8, label: 'Done', icon: Rocket, optional: false },
];

const FIRST_STEP = 1;
const LAST_STEP = STEPS.length;

export interface OnboardingWizardProps {
  /** Non-null when resuming: the site this wizard already created. */
  website: OnboardingWebsite | null;
  initialStep: number;
  googleSetup: GoogleSetup;
  aiProviders: AiProviderOption[];
  defaultAiProvider: string | null;
}

export function OnboardingWizard({
  website,
  initialStep,
  googleSetup,
  aiProviders,
  defaultAiProvider,
}: OnboardingWizardProps) {
  const router = useRouter();
  const [site, setSite] = React.useState<OnboardingWebsite | null>(website);
  const [step, setStep] = React.useState(() => {
    const clamped = Math.min(Math.max(initialStep, FIRST_STEP), LAST_STEP);
    // Everything past step 2 is scoped to a site; without one there is nothing to show.
    return !website && clamped > 2 ? 2 : clamped;
  });

  /*
   * The step lives in the URL so a refresh, a back button or the Google OAuth round trip all
   * land where the user left off. `history.replaceState` keeps that true without a server
   * round trip on every click — nothing on this page is derived from the query after mount.
   */
  React.useEffect(() => {
    const query = new URLSearchParams({ step: String(step) });
    if (site) query.set('site', site.id);
    window.history.replaceState(null, '', `/onboarding?${query.toString()}`);
  }, [step, site]);

  const goTo = React.useCallback((next: number) => {
    setStep(Math.min(Math.max(next, FIRST_STEP), LAST_STEP));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const next = React.useCallback(() => goTo(step + 1), [goTo, step]);
  const back = React.useCallback(() => goTo(step - 1), [goTo, step]);

  const onSiteSaved = React.useCallback((saved: OnboardingWebsite) => setSite(saved), []);

  // The authenticated shell reads the site list on the server; refresh it once there is one.
  React.useEffect(() => {
    if (step === LAST_STEP) router.refresh();
  }, [step, router]);

  const active = STEPS[step - 1] ?? STEPS[0];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8 md:px-6 md:py-12">
      <header className="mb-8 flex items-center gap-3">
        <span className="flex size-9 items-center justify-center rounded-xl border border-border bg-card shadow-xs">
          <Radar className="size-4 text-primary" aria-hidden="true" />
        </span>
        <div>
          <h1 className="text-sm font-semibold tracking-tight">Set up SEO OS</h1>
          <p className="text-xs text-muted-foreground">
            Step {step} of {LAST_STEP} · {active?.label}
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Setup progress" className="lg:sticky lg:top-8 lg:self-start">
          <ol className="flex gap-1 overflow-x-auto pb-2 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
            {STEPS.map((definition) => {
              const done = definition.id < step;
              const current = definition.id === step;
              // Steps ahead of the furthest point reached are not reachable by click; the
              // wizard has to run in order for the site to exist when later steps need it.
              const reachable = definition.id <= step;
              const Icon = definition.icon;

              return (
                <li key={definition.id}>
                  <button
                    type="button"
                    onClick={() => reachable && goTo(definition.id)}
                    disabled={!reachable}
                    aria-current={current ? 'step' : undefined}
                    className={cn(
                      'flex w-full shrink-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      current && 'bg-primary/10 font-medium text-primary',
                      !current && reachable && 'text-muted-foreground hover:bg-accent hover:text-foreground',
                      !reachable && 'cursor-default text-muted-foreground',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs',
                        done && 'border-success/30 bg-success/15 text-success',
                        current && 'border-primary/40 bg-primary/15 text-primary',
                        !done && !current && 'border-border bg-muted text-muted-foreground',
                      )}
                    >
                      {done ? <Check className="size-3" /> : <Icon className="size-3" />}
                    </span>
                    <span className="truncate">{definition.label}</span>
                    {definition.optional ? (
                      <span className="ml-auto hidden text-2xs text-muted-foreground lg:inline">
                        optional
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <Card className="p-6 shadow-card md:p-7">
          {step === 1 ? <StepWelcome onNext={next} /> : null}

          {step === 2 ? <StepWebsite site={site} onSaved={onSiteSaved} onNext={next} onBack={back} /> : null}

          {step === 3 && site ? (
            <StepBusiness site={site} onSaved={onSiteSaved} onNext={next} onBack={back} />
          ) : null}

          {step === 4 && site ? (
            <StepCompetitors site={site} onSaved={onSiteSaved} onNext={next} onBack={back} />
          ) : null}

          {step === 5 && site ? (
            <StepSearchConsole site={site} googleSetup={googleSetup} onNext={next} onBack={back} />
          ) : null}

          {step === 6 ? (
            <StepAiProvider
              initialProviders={aiProviders}
              initialSelection={defaultAiProvider}
              onNext={next}
              onBack={back}
            />
          ) : null}

          {step === 7 && site ? <StepCrawl site={site} onNext={next} onBack={back} /> : null}

          {step === 8 && site ? <StepDone site={site} /> : null}
        </Card>
      </div>
    </div>
  );
}
