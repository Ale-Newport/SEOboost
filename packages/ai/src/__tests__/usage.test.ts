import { AppError } from '@seo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The budget guard is the only thing standing between an agent loop and an unbounded bill, so
 * it is tested against a stubbed `@seo/db`: no Postgres, just the two aggregates it issues.
 */
const fixture = vi.hoisted(() => {
  const spendByScope = { portfolio: 0, site: 0 };
  const perSiteBudget: { value: number | null } = { value: null };

  const aggregate = vi.fn(async (args: { where?: { websiteId?: string } }) => ({
    _sum: { costUsd: args.where?.websiteId ? spendByScope.site : spendByScope.portfolio },
  }));
  const findUnique = vi.fn(async () => ({ monthlyAiBudgetUsd: perSiteBudget.value }));

  return { spendByScope, perSiteBudget, aggregate, findUnique };
});

vi.mock('@seo/db', () => ({
  prisma: {
    aiUsage: { aggregate: fixture.aggregate, create: vi.fn(async () => ({})) },
    websiteSettings: { findUnique: fixture.findUnique },
  },
  getAppSetting: vi.fn(async (_key: string, fallback: unknown) => fallback),
}));

const { assertWithinBudget, getMonthlySpend } = await import('../usage');

afterEach(() => {
  vi.unstubAllEnvs();
  fixture.spendByScope.portfolio = 0;
  fixture.spendByScope.site = 0;
  fixture.perSiteBudget.value = null;
});

describe('assertWithinBudget', () => {
  it('enforces the install-wide cap against portfolio spend, not per-site spend', async () => {
    // The regression: with a $10 cap and ten sites, checking $10 against each site's own spend
    // lets the install spend $100.
    vi.stubEnv('AI_MONTHLY_BUDGET_USD', '10');
    fixture.spendByScope.portfolio = 12;
    fixture.spendByScope.site = 3;

    await expect(assertWithinBudget('site-1')).rejects.toMatchObject({
      code: 'AI_BUDGET_EXCEEDED',
      status: 429,
    });
  });

  it('still enforces a per-site cap when the install-wide cap has room', async () => {
    vi.stubEnv('AI_MONTHLY_BUDGET_USD', '1000');
    fixture.spendByScope.portfolio = 40;
    fixture.spendByScope.site = 40;
    fixture.perSiteBudget.value = 25;

    const err = await assertWithinBudget('site-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details).toMatchObject({ budgetSource: 'website', budgetUsd: 25 });
  });

  it('allows a site its larger own allowance under the install-wide ceiling', async () => {
    vi.stubEnv('AI_MONTHLY_BUDGET_USD', '100');
    fixture.spendByScope.portfolio = 50;
    fixture.spendByScope.site = 40;
    fixture.perSiteBudget.value = 80;

    const status = await assertWithinBudget('site-1');
    expect(status).toMatchObject({ budgetSource: 'website', budgetUsd: 80, exceeded: false });
  });

  it('treats an unset budget as unlimited rather than a zero cap', async () => {
    fixture.spendByScope.portfolio = 500;
    fixture.spendByScope.site = 500;

    const status = await assertWithinBudget('site-1');
    expect(status.budgetUsd).toBeNull();
    expect(status.budgetSource).toBe('none');
  });
});

describe('getMonthlySpend', () => {
  it('measures the portfolio against the install-wide cap', async () => {
    vi.stubEnv('AI_MONTHLY_BUDGET_USD', '200');
    fixture.spendByScope.portfolio = 50;

    const status = await getMonthlySpend(null);
    expect(status).toMatchObject({
      budgetSource: 'global',
      budgetUsd: 200,
      spendUsd: 50,
      remainingUsd: 150,
      percentUsed: 25,
      exceeded: false,
    });
  });

  it('reports a site with no cap of its own as uncapped at site scope', async () => {
    vi.stubEnv('AI_MONTHLY_BUDGET_USD', '200');
    fixture.spendByScope.site = 10;

    const status = await getMonthlySpend('site-1');
    expect(status).toMatchObject({ websiteId: 'site-1', budgetUsd: null, budgetSource: 'none' });
  });
});
