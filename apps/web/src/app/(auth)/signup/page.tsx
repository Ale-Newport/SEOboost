import type { Metadata } from 'next';
import Link from 'next/link';
import { Lock } from 'lucide-react';
import { env } from '@seo/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { hasAnyUser } from '@/lib/auth';
import { safeNextPath } from '../auth-form-utils';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Create account' };

interface SignupPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === 'string' ? params.next : undefined);

  const anyUser = await hasAnyUser();
  // The first account is always allowed: an empty installation must be claimable.
  const signupAllowed = !anyUser || env.allowSignup;

  if (!signupAllowed) {
    return (
      <Card className="shadow-card">
        <CardHeader className="pb-3">
          <span className="mb-1 flex size-8 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground">
            <Lock className="size-4" aria-hidden="true" />
          </span>
          <h1 className="text-base font-semibold leading-tight tracking-tight">Sign-up is closed</h1>
          <CardDescription>
            This installation already has an account and self-service sign-up is switched off.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4 pt-0">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Ask the owner to create an account for you. They can re-open sign-up by setting{' '}
            <code className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-2xs text-foreground">
              ALLOW_SIGNUP=true
            </code>{' '}
            in the environment and restarting the app.
          </p>
          <Button asChild className="w-full">
            <Link href={next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`}>
              Back to sign in
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <SignupForm nextPath={next} isFirstUser={!anyUser} />;
}
