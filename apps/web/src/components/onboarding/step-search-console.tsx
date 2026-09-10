'use client';

import { ArrowRight, CircleCheck, LineChart, Link2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StepFooter, StepHeader } from './step-shell';
import type { GoogleSetup, OnboardingWebsite } from './types';

/**
 * OAuth has to be a real navigation, not a fetch: the consent screen is Google's page and the
 * callback needs a top-level redirect back to this origin. `redirectTo` carries the wizard
 * position so the user returns to this step rather than the start.
 */
const CONNECT_ENDPOINT = '/api/integrations/google/authorize';
const SEARCH_CONSOLE_PROVIDER = 'GOOGLE_SEARCH_CONSOLE';

const UNLOCKS = [
  'Real clicks, impressions, CTR and average position per query and per page',
  'Striking-distance and CTR opportunities, which are computed from measured data only',
  'Decay detection and cannibalisation checks across your own queries',
];

interface StepSearchConsoleProps {
  site: OnboardingWebsite;
  googleSetup: GoogleSetup;
  onNext: () => void;
  onBack: () => void;
}

export function StepSearchConsole({ site, googleSetup, onNext, onBack }: StepSearchConsoleProps) {
  const returnTo = `/onboarding?step=5&site=${encodeURIComponent(site.id)}`;
  const connectHref =
    `${CONNECT_ENDPOINT}?websiteId=${encodeURIComponent(site.id)}` +
    `&provider=${SEARCH_CONSOLE_PROVIDER}` +
    `&redirectTo=${encodeURIComponent(returnTo)}`;

  return (
    <div>
      <StepHeader
        icon={LineChart}
        title="Connect Google Search Console"
        description="The only source of your real search performance. Without it, every screen that needs clicks or positions stays empty rather than estimating."
      />

      <div className="mt-6 space-y-4">
        {site.searchConsoleConnected ? (
          <Alert variant="success">
            <AlertTitle>Search Console is connected</AlertTitle>
            <AlertDescription>
              Performance data will sync on the schedule set in this site&rsquo;s settings.
            </AlertDescription>
          </Alert>
        ) : null}

        <ul className="space-y-2">
          {UNLOCKS.map((item) => (
            <li key={item} className="flex gap-2.5 text-sm leading-relaxed text-muted-foreground">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              <span>{item}</span>
            </li>
          ))}
        </ul>

        {googleSetup.configured ? (
          <div className="rounded-md border border-border bg-muted/30 p-4">
            <p className="text-sm font-medium">Sign in with the Google account that owns the property</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              You will be asked for read access to Search Console and Analytics. Tokens are
              encrypted before they are stored and are never returned to the browser.
            </p>
            <Button asChild className="mt-3">
              <a href={connectHref}>
                <Link2 aria-hidden="true" />
                {site.searchConsoleConnected ? 'Reconnect Google' : 'Connect Google'}
              </a>
            </Button>
          </div>
        ) : (
          <Alert variant="neutral">
            <AlertTitle>Google OAuth is not configured on this installation</AlertTitle>
            <AlertDescription>
              <p className="leading-relaxed">
                Create an OAuth client in the Google Cloud console, then set{' '}
                {googleSetup.missingEnvVars.length > 0 ? 'the missing variables' : 'these variables'} and
                restart the app:
              </p>
              <ul className="mt-2 space-y-1">
                {(googleSetup.missingEnvVars.length > 0
                  ? googleSetup.missingEnvVars
                  : ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']
                ).map((name) => (
                  <li key={name}>
                    <code className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
                      {name}
                    </code>
                  </li>
                ))}
              </ul>
              <p className="mt-2 leading-relaxed">
                The redirect URI defaults to{' '}
                <code className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
                  {'<APP_URL>'}/api/integrations/google/callback
                </code>
                , or set <code className="font-mono text-2xs">GOOGLE_REDIRECT_URI</code> explicitly.
                You can finish setup now and connect later from the site&rsquo;s settings.
              </p>
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Connecting navigates away, so the footer action is only ever "move on" — labelled for
          what it actually does rather than offering a second button that does the same thing. */}
      <StepFooter onBack={onBack}>
        <Button onClick={onNext} variant={site.searchConsoleConnected ? 'default' : 'outline'}>
          {site.searchConsoleConnected ? 'Continue' : 'Skip for now'}
          <ArrowRight aria-hidden="true" />
        </Button>
      </StepFooter>
    </div>
  );
}
