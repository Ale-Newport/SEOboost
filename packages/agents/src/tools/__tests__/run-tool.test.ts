import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ForbiddenError, NotFoundError, ValidationError } from '@seo/shared';

/**
 * `runTool` tests.
 *
 * The database is mocked because none of the behaviour under test needs it: the whole point of
 * `runTool` is what happens *around* a tool call — permission, validation, timing and the run
 * transcript — and the tool under test is a spy that records what it was handed.
 */
const db = vi.hoisted(() => ({
  prisma: {
    agentRun: { findUnique: vi.fn() },
  },
}));

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

const { registerTool, runTool } = await import('../index');
const { bindRunToAgent, registerAgent, resetAgentRegistry } = await import('../../runtime/registry');

const RUN_ID = 'run-1';
const execute = vi.fn();

function makeContext() {
  return {
    websiteId: 'site-1',
    userId: null,
    trigger: 'manual' as const,
    runId: RUN_ID,
    input: {},
    recordToolCall: vi.fn(),
    log: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentRegistry();

  registerTool({
    name: 'testEchoTool',
    description: 'Test double that echoes its parsed arguments.',
    readOnly: true,
    schema: z.object({
      pageId: z.string().min(1),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    execute: async (args: { pageId: string; limit?: number }) => {
      execute(args);
      return { ok: true, ...args };
    },
  });

  registerAgent({
    name: 'TechnicalSEOAgent',
    label: 'Technical SEO',
    description: 'test double',
    allowedActionTypes: [],
    tools: ['testEchoTool'],
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
});

describe('runTool — argument validation', () => {
  it('rejects arguments of the wrong type', async () => {
    const context = makeContext();

    await expect(runTool('testEchoTool', { pageId: 42 }, context)).rejects.toBeInstanceOf(ValidationError);
    expect(execute).not.toHaveBeenCalled();
    expect(context.recordToolCall).not.toHaveBeenCalled();
  });

  it('rejects missing required arguments and names the offending path', async () => {
    await expect(runTool('testEchoTool', {}, makeContext())).rejects.toThrow(/pageId/);
  });

  it('rejects arguments outside the declared range', async () => {
    await expect(
      runTool('testEchoTool', { pageId: 'page-1', limit: 99 }, makeContext()),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a non-object payload', async () => {
    await expect(runTool('testEchoTool', 'page-1', makeContext())).rejects.toBeInstanceOf(ValidationError);
  });

  it('passes parsed arguments through and records the call on success', async () => {
    const context = makeContext();
    const result = await runTool<{ ok: boolean; pageId: string }>(
      'testEchoTool',
      { pageId: 'page-1', limit: 3 },
      context,
    );

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledWith({ pageId: 'page-1', limit: 3 });
    expect(context.recordToolCall).toHaveBeenCalledTimes(1);

    const [name, args, recorded, durationMs] = context.recordToolCall.mock.calls[0] as [
      string,
      unknown,
      unknown,
      number,
    ];
    expect(name).toBe('testEchoTool');
    expect(args).toEqual({ pageId: 'page-1', limit: 3 });
    expect(recorded).toMatchObject({ ok: true });
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('runTool — permissions', () => {
  it('refuses a tool the agent did not declare', async () => {
    const context = makeContext();
    await expect(runTool('getWebsite', {}, context)).rejects.toBeInstanceOf(ForbiddenError);
    expect(context.recordToolCall).not.toHaveBeenCalled();
  });

  it('throws for an unknown tool name', async () => {
    await expect(runTool('noSuchTool', {}, makeContext())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('records the failure in the transcript when a tool throws', async () => {
    registerTool({
      name: 'testFailingTool',
      description: 'Always throws.',
      readOnly: true,
      schema: z.object({}),
      execute: async () => {
        throw new Error('boom');
      },
    });
    registerAgent({
      name: 'KeywordAgent',
      label: 'Keyword',
      description: 'test double',
      allowedActionTypes: [],
      tools: ['testFailingTool'],
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
    bindRunToAgent(RUN_ID, 'KeywordAgent');

    const context = makeContext();
    await expect(runTool('testFailingTool', {}, context)).rejects.toThrow('boom');
    expect(context.recordToolCall).toHaveBeenCalledTimes(1);
    expect(context.recordToolCall.mock.calls[0]?.[2]).toEqual({ error: 'boom' });
  });
});
