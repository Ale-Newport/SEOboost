import type { Page } from '@playwright/test';

/** A unique account per run so tests never collide on the unique email index. */
export function testAccount() {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return {
    email: `e2e-${stamp}@example.test`,
    password: 'E2eTestPassword!2026',
    name: 'E2E Tester',
  };
}

/**
 * `page.goto` that tolerates a client-side redirect still in flight from the previous page
 * (e.g. a new account on `/` being sent to `/onboarding`), which otherwise aborts the
 * navigation with "interrupted by another navigation" on a slow dev server.
 */
export async function gotoStable(page: Page, url: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url);
      return;
    } catch (err) {
      if (attempt >= 3 || !/interrupted by another navigation/i.test(String(err))) throw err;
      await page.waitForLoadState('load');
    }
  }
}

export async function signUp(page: Page, account: ReturnType<typeof testAccount>) {
  await gotoStable(page, '/signup');
  await page.getByLabel(/email/i).fill(account.email);
  await page.getByLabel(/password/i).first().fill(account.password);
  const nameField = page.getByLabel(/name/i);
  if (await nameField.count()) await nameField.first().fill(account.name);
  await page.getByRole('button', { name: /sign up|create account/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/signup'), { timeout: 30_000 });
}

export async function signIn(page: Page, account: { email: string; password: string }) {
  await gotoStable(page, '/login');
  await page.getByLabel(/email/i).fill(account.email);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill(account.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
}
