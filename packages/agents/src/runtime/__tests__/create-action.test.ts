import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError } from '@seo/shared';

/**
 * Guardrail tests for `createActionFromAgent`.
 *
 * The whole database is replaced with spies: the point of these tests is that an agent cannot
 * create an action type it did not declare, and that the refusal happens *before* any row is
 * read or written. A test that needed Postgres could not prove the second half.
 */
const db = vi.hoisted(() => {
  const prisma = {
    seoAction: { findFirst: vi.fn(), create: vi.fn() },
    websiteSettings: { findUnique: vi.fn() },
    experiment: { findMany: vi.fn() },
    approval: { create: vi.fn() },
    changeLog: { create: vi.fn() },
    agentRun: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    aiUsage: { findMany: vi.fn() },
    $transaction: vi.fn(),
  };
  return { prisma };
});

vi.mock('@seo/db', () => ({
  prisma: db.prisma,
  json: (value: unknown) => value,
  isUniqueViolation: () => false,
  createManyChunked: vi.fn(),
  paginate: (page: number, pageSize: number) => ({ skip: (page - 1) * pageSize, take: pageSize }),
  buildPaginated: (items: unknown[], total: number, page: number, pageSize: number) => ({
    items,
    total,
    page,
    pageSize,
    totalPages: 1,
  }),
}));

// Imported after the mock declaration; `vi.mock` is hoisted above both by the transform.
const { createActionFromAgent } = await import('../run');
const { bindRunToAgent, registerAgent, resetAgentRegistry, unbindRun } = await import('../registry');

const RUN_ID = 'run-1';
const WEBSITE_ID = 'site-1';

function makeContext() {
  return {
    websiteId: WEBSITE_ID,
    userId: null,
    trigger: 'manual' as const,
    runId: RUN_ID,
    input: {},
    recordToolCall: vi.fn(),
    log: vi.fn(),
  };
}

/** A minimal agent that may only ever propose title rewrites. */
function registerTitleOnlyAgent() {
  registerAgent({
    name: 'TechnicalSEOAgent',
    label: 'Technical SEO',
    description: 'test double',
    allowedActionTypes: ['UPDATE_TITLE'],
    tools: [],
    requiresAi: false,
    run: async () => ({
      summary: 'noop',
      confidence: 1,
      actionsCreated: [],
      approvalsCreated: [],
      findings: [],
      data: {},
    }),
  });
  bindRunToAgent(RUN_ID, 'TechnicalSEOAgent');
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentRegistry();
  registerTitleOnlyAgent();

  db.prisma.seoAction.findFirst.mockResolvedValue(null);
  db.prisma.websiteSettings.findUnique.mockResolvedValue({
    autonomyLevel: 'L1_DRAFTS_ONLY',
    autoApproveSafe: false,
  });
  db.prisma.experiment.findMany.mockResolvedValue([]);
  db.prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      seoAction: { create: vi.fn().mockResolvedValue({ id: 'action-1' }) },
      approval: { create: vi.fn().mockResolvedValue({ id: 'approval-1' }) },
      changeLog: { create: vi.fn().mockResolvedValue({ id: 'log-1' }) },
    }),
  );
});

const baseInput = {
  title: 'Rewrite the title of /pricing',
  reasoning: 'The current title is 92 characters and truncates in the SERP.',
  impact: 0.5,
  confidence: 0.7,
  businessValue: 0.6,
  effort: 1,
};

describe('createActionFromAgent — allowed action types', () => {
  it('refuses an action type the calling agent did not declare', async () => {
    await expect(
      createActionFromAgent(makeContext(), { ...baseInput, type: 'CREATE_REDIRECT' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('names the agent and its allowed types in the refusal', async () => {
    await expect(
      createActionFromAgent(makeContext(), { ...baseInput, type: 'CONSOLIDATE_PAGES' }),
    ).rejects.toThrow(/TechnicalSEOAgent is not allowed to create CONSOLIDATE_PAGES.*UPDATE_TITLE/s);
  });

  it('refuses before touching the database', async () => {
    await expect(
      createActionFromAgent(makeContext(), { ...baseInput, type: 'PUBLISH_CONTENT' }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    expect(db.prisma.seoAction.findFirst).not.toHaveBeenCalled();
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates the action when the type is declared', async () => {
    const result = await createActionFromAgent(makeContext(), { ...baseInput, type: 'UPDATE_TITLE' });

    expect(result.created).toBe(true);
    expect(result.actionId).toBe('action-1');
    // L1 autonomy never auto-executes, so an approval must have been raised.
    expect(result.status).toBe('AWAITING_APPROVAL');
    expect(result.approvalId).toBe('approval-1');
    expect(result.autoExecutable).toBe(false);
    expect(result.priority.score).toBeGreaterThan(0);
    expect(result.priority.factors.length).toBeGreaterThan(0);
  });

  it('does not re-propose a sourced finding a human rejected inside the cooldown', async () => {
    // Nothing open, but the same source was rejected recently.
    db.prisma.seoAction.findFirst.mockImplementation(async (args: { where: { status?: unknown } }) =>
      args.where.status === 'REJECTED'
        ? { id: 'action-rejected', status: 'REJECTED', risk: 'SAFE', priorityScore: 42 }
        : null,
    );

    const result = await createActionFromAgent(makeContext(), {
      ...baseInput,
      type: 'UPDATE_TITLE',
      sourceType: 'technical-issue',
      sourceId: 'issue-1',
    });

    expect(result.created).toBe(false);
    expect(result.actionId).toBe('action-rejected');
    expect(result.reason).toMatch(/rejected/i);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails closed when the run cannot be attributed to a registered agent', async () => {
    unbindRun(RUN_ID);
    db.prisma.agentRun.findUnique.mockResolvedValue(null);

    await expect(
      createActionFromAgent(makeContext(), { ...baseInput, type: 'UPDATE_TITLE' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(db.prisma.$transaction).not.toHaveBeenCalled();
  });
});
