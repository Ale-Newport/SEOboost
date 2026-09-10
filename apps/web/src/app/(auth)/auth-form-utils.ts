import type { ZodError } from 'zod';

/**
 * Helpers shared by the sign-in and sign-up forms.
 *
 * Both forms validate with the same Zod schemas the API route uses, then have to render
 * whichever side rejected the input. Keeping the two translations here means a field error
 * looks identical whether it was caught in the browser or returned by the server.
 */

export type FieldErrors = Record<string, string>;

/** First message per field — a control can only display one, and the first is the most specific. */
export function fieldErrorsFromZod(error: ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    if (key && !errors[key]) errors[key] = issue.message;
  }
  return errors;
}

/**
 * `ApiError.details` is `unknown` by design: it crosses the network. The API route wrapper
 * emits `[{ path, message }]` for a `ZodError`, and anything else is ignored rather than
 * trusted, so a malformed body can never produce a bogus field error.
 */
export function fieldErrorsFromApiDetails(details: unknown): FieldErrors {
  if (!Array.isArray(details)) return {};
  const errors: FieldErrors = {};
  for (const entry of details) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { path, message } = entry as { path?: unknown; message?: unknown };
    if (typeof path === 'string' && typeof message === 'string' && path && !errors[path]) {
      errors[path] = message;
    }
  }
  return errors;
}

/**
 * Only same-origin, absolute-path redirects survive.
 *
 * `?next=` is attacker-controllable (the middleware puts it there, but so can anyone with a
 * link), so anything that could leave this origin — a scheme, a protocol-relative `//host`,
 * or a backslash IE/WHATWG treats as a slash — is discarded rather than sanitised.
 */
export function safeNextPath(value: string | undefined | null, fallback = '/'): string {
  if (!value) return fallback;
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (value.includes('\\')) return fallback;
  return value;
}
