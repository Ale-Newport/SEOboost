import { expect, test } from '@playwright/test';

test('health endpoint reports subsystem status without leaking secrets', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.ok()).toBeTruthy();

  const body = await response.json();
  expect(body).toHaveProperty('database');

  // The health payload is the most likely place to leak configuration by accident.
  const serialised = JSON.stringify(body).toLowerCase();
  for (const forbidden of ['sk-ant-', 'sk-proj-', 'password', 'secret', 'client_secret', 'apikey']) {
    expect(serialised).not.toContain(forbidden);
  }
});
