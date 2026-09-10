'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Eye, EyeOff } from 'lucide-react';
import { loginSchema } from '@seo/shared/validation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { fieldErrorsFromApiDetails, fieldErrorsFromZod, type FieldErrors } from '../auth-form-utils';

interface LoginFormProps {
  /** Already validated as a same-origin path by the server component. */
  nextPath: string;
  /** A sign-up link is only shown when someone could actually complete one. */
  signupAllowed: boolean;
}

export function LoginForm({ nextPath, signupAllowed }: LoginFormProps) {
  const router = useRouter();
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const parsed = loginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    try {
      await apiPost('/api/auth/login', parsed.data);
      // `refresh()` first so the authenticated layout is rebuilt with the new session cookie.
      router.refresh();
      router.push(nextPath);
    } catch (error) {
      const details = error instanceof ApiError ? fieldErrorsFromApiDetails(error.details) : {};
      setFieldErrors(details);
      setFormError(
        error instanceof ApiError
          ? error.message
          : 'Could not reach the server. Check your connection and try again.',
      );
      setSubmitting(false);
    }
  };

  return (
    <Card className="shadow-card">
      <CardHeader className="pb-3">
        {/* The card heading is the page's h1 — the brand mark above it is not a heading. */}
        <h1 className="text-base font-semibold leading-tight tracking-tight">Sign in</h1>
        <CardDescription>Use the account for this installation.</CardDescription>
      </CardHeader>

      <CardContent className="pt-0">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription className="text-foreground">{formError}</AlertDescription>
            </Alert>
          ) : null}

          <FormField label="Email" error={fieldErrors.email} required>
            <Input
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
              autoFocus
              spellCheck={false}
              placeholder="you@company.com"
              disabled={submitting}
            />
          </FormField>

          <FormField label="Password" error={fieldErrors.password} required>
            <div className="relative">
              <Input
                type={showPassword ? 'text' : 'password'}
                name="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                placeholder="••••••••••"
                className="pr-10"
                disabled={submitting}
              />
              <button
                type="button"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className={cn(
                  'absolute right-1 top-1 flex size-7 items-center justify-center rounded-sm text-muted-foreground',
                  'transition-colors hover:text-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                {showPassword ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </FormField>

          <Button type="submit" className="w-full" loading={submitting} loadingText="Signing in">
            Sign in
          </Button>
        </form>

        {signupAllowed ? (
          <p className="mt-5 text-center text-sm text-muted-foreground">
            No account yet?{' '}
            <Link
              href={nextPath === '/' ? '/signup' : `/signup?next=${encodeURIComponent(nextPath)}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Create one
            </Link>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
