'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Check, Eye, EyeOff, Minus } from 'lucide-react';
import { signupSchema } from '@seo/shared/validation';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { ApiError, apiPost } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { fieldErrorsFromApiDetails, fieldErrorsFromZod, type FieldErrors } from '../auth-form-utils';

interface SignupFormProps {
  nextPath: string;
  /** The first account owns the installation; say so rather than letting it be a surprise. */
  isFirstUser: boolean;
}

/**
 * Live mirror of `passwordSchema` in @seo/shared.
 *
 * The schema stays the authority — it runs on submit here and again on the server — but a
 * rule you can only discover by failing is a bad rule, so the same two conditions are shown
 * while typing.
 */
const PASSWORD_RULES: Array<{ id: string; label: string; test: (value: string) => boolean }> = [
  { id: 'length', label: 'At least 10 characters', test: (value) => value.length >= 10 },
  {
    id: 'mix',
    label: 'At least one letter and one number or symbol',
    test: (value) =>
      /[a-zA-Z]/.test(value) && /[0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(value),
  },
];

export function SignupForm({ nextPath, isFirstUser }: SignupFormProps) {
  const router = useRouter();
  const [name, setName] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<FieldErrors>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const parsed = signupSchema.safeParse({
      email,
      password,
      // An untouched optional field must be absent, not an empty string.
      name: name.trim() === '' ? undefined : name,
    });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFromZod(parsed.error));
      return;
    }
    setFieldErrors({});
    setSubmitting(true);

    try {
      await apiPost('/api/auth/signup', parsed.data);
      router.refresh();
      // A brand-new account has no websites yet, so the shell would bounce it here anyway.
      router.push(nextPath === '/' ? '/onboarding' : nextPath);
    } catch (error) {
      setFieldErrors(error instanceof ApiError ? fieldErrorsFromApiDetails(error.details) : {});
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
        <h1 className="text-base font-semibold leading-tight tracking-tight">
          {isFirstUser ? 'Create the owner account' : 'Create your account'}
        </h1>
        <CardDescription>
          {isFirstUser
            ? 'This is the first account on this installation, so it becomes the owner.'
            : 'You will be able to add websites straight after signing up.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="pt-0">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription className="text-foreground">{formError}</AlertDescription>
            </Alert>
          ) : null}

          <FormField label="Name" description="Optional — shown on reports and change history." error={fieldErrors.name}>
            <Input
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoComplete="name"
              placeholder="Alex Rivera"
              disabled={submitting}
            />
          </FormField>

          <FormField label="Email" error={fieldErrors.email} required>
            <Input
              type="email"
              name="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="username"
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
                autoComplete="new-password"
                placeholder="At least 10 characters"
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

          <ul className="space-y-1.5" aria-label="Password requirements">
            {PASSWORD_RULES.map((rule) => {
              const met = rule.test(password);
              return (
                <li key={rule.id} className="flex items-center gap-2 text-xs">
                  <span
                    aria-hidden="true"
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-full border',
                      met
                        ? 'border-success/30 bg-success/15 text-success'
                        : 'border-border bg-muted text-muted-foreground',
                    )}
                  >
                    {met ? <Check className="size-2.5" /> : <Minus className="size-2.5" />}
                  </span>
                  <span className={cn('leading-relaxed', met ? 'text-foreground' : 'text-muted-foreground')}>
                    {rule.label}
                  </span>
                  <span className="sr-only">{met ? '— met' : '— not met yet'}</span>
                </li>
              );
            })}
          </ul>

          <Button type="submit" className="w-full" loading={submitting} loadingText="Creating account">
            Create account
          </Button>
        </form>

        <p className="mt-5 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link
            href={nextPath === '/' ? '/login' : `/login?next=${encodeURIComponent(nextPath)}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
