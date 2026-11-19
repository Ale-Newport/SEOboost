import { expect, test } from '@playwright/test';
import { testAccount } from './helpers';

/**
 * Regression test for simultaneous sign-ups. Account creation is serialised with a Postgres
 * advisory lock, so however many sign-ups race, at most one of them can become OWNER — and on a
 * fresh database exactly one does.
 */
test('concurrent sign-ups never create more than one OWNER', async ({ playwright, baseURL }) => {
  const origin = new URL(baseURL ?? 'http://localhost:3000').origin;
  const attempts = await Promise.all(
    Array.from({ length: 6 }, async () => {
      // Separate contexts: separate cookies, like separate browsers.
      const api = await playwright.request.newContext({ baseURL: origin, extraHTTPHeaders: { origin } });
      const account = testAccount();
      const response = await api.post('/api/auth/signup', {
        data: { email: account.email, password: account.password, name: account.name },
      });
      const body = response.ok() ? await response.json() : null;
      await api.dispose();
      return { status: response.status(), role: body?.user?.role as string | undefined };
    }),
  );

  const created = attempts.filter((a) => a.status === 200);
  expect(created.length).toBeGreaterThan(0);
  expect(created.filter((a) => a.role === 'OWNER').length).toBeLessThanOrEqual(1);
});
