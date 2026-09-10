import { expect, test } from '@playwright/test';
import { signIn, signUp, testAccount } from './helpers';

test.describe('authentication', () => {
  test('rejects an unknown account without revealing which field was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('nobody@example.test');
    await page.getByLabel(/password/i).fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in|log in/i }).click();

    const error = page.getByText(/incorrect email or password/i);
    await expect(error).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('protects the dashboard from anonymous visitors', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/sites');
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs up, lands in the app, and signs back in', async ({ page }) => {
    const account = testAccount();

    await signUp(page, account);
    await expect(page).not.toHaveURL(/\/(login|signup)/);

    // Sign out, then back in with the same credentials.
    await page.goto('/');
    const menu = page.getByRole('button', { name: /account menu/i });
    if (await menu.count()) {
      await menu.click();
      await page.getByRole('menuitem', { name: /sign out/i }).click();
      await page.waitForURL(/\/login/, { timeout: 30_000 });
    } else {
      await page.context().clearCookies();
    }

    await signIn(page, account);
    await expect(page).not.toHaveURL(/\/login/);
  });
});
