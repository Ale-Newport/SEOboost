import 'server-only';
import { RateLimitError, env } from '@seo/shared';
import { consumeRateLimit, resetRateLimit, type RateLimitRule } from '@seo/queue';

/**
 * Best-effort client IP. Self-hosted installs normally sit behind a reverse proxy that sets
 * these headers; without one they can be spoofed, which is why sign-in also has a per-account
 * limit that does not depend on the IP at all.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  const ip = first || request.headers.get('x-real-ip')?.trim() || 'unknown';
  // Bound the key length: the header is client-controlled.
  return ip.slice(0, 64);
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 320);
}

async function enforce(rules: RateLimitRule[]): Promise<void> {
  const result = await consumeRateLimit(rules);
  if (!result.allowed) {
    throw new RateLimitError(
      `Too many attempts. Try again in ${Math.max(1, Math.ceil(result.retryAfterSeconds / 60))} minute(s).`,
      result.retryAfterSeconds,
    );
  }
}

/** Charge one sign-in attempt to the client IP and to the account being tried. */
export async function enforceLoginRateLimit(request: Request, email: string): Promise<void> {
  const windowMs = env.authRateLimitWindowSeconds * 1000;
  await enforce([
    { key: `login:ip:${clientIp(request)}`, limit: env.authRateLimitPerIp, windowMs },
    { key: `login:account:${normaliseEmail(email)}`, limit: env.authRateLimitPerAccount, windowMs },
  ]);
}

/** A successful sign-in clears the account's counter so its owner is never locked out later. */
export async function clearLoginRateLimit(email: string): Promise<void> {
  await resetRateLimit(`login:account:${normaliseEmail(email)}`).catch(() => undefined);
}

export async function enforceSignupRateLimit(request: Request): Promise<void> {
  await enforce([
    {
      key: `signup:ip:${clientIp(request)}`,
      limit: env.signupRateLimitPerIp,
      windowMs: env.authRateLimitWindowSeconds * 1000,
    },
  ]);
}
