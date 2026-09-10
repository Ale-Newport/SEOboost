import type { Metadata } from 'next';
import { env } from '@seo/shared';
import { hasAnyUser } from '@/lib/auth';
import { safeNextPath } from '../auth-form-utils';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in' };

interface LoginPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const next = typeof params.next === 'string' ? params.next : undefined;

  /*
   * An empty installation must always be able to create its first account, otherwise an
   * operator who set ALLOW_SIGNUP=false before booting would be locked out of their own box.
   */
  const signupAllowed = env.allowSignup || !(await hasAnyUser());

  return <LoginForm nextPath={safeNextPath(next)} signupAllowed={signupAllowed} />;
}
