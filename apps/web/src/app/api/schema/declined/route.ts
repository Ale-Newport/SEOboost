import { z } from 'zod';
import { AgentRunStatus, prisma, readJson } from '@seo/db';
import { readQuery, route } from '@/lib/api';
import { requireScopedWebsite, websiteScopeSchema } from '@/app/api/_lib/common';

/**
 * `GET /api/schema/declined?websiteId=` — the schema types the generator refused to emit.
 *
 * Refusing to invent markup is a feature, not a gap, so the reasons are first-class output
 * rather than a log line: "FAQPage not generated, only one genuine Q&A pair is visible on the
 * page" is exactly the sentence that stops an operator hand-writing spammy markup instead.
 *
 * The reasons live on the schema agent's run record (`AgentRun.output.findings`, tagged
 * `schema-declined`), which is the only place they are persisted — declining produces no row
 * in `StructuredDataItem` by definition.
 */

const querySchema = websiteScopeSchema.extend({
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

interface DeclinedFinding {
  url: string;
  schemaType: string;
  reason: string;
}

interface SchemaRunOutput {
  findings?: unknown[];
  data?: { declined?: number; policy?: string };
}

/** Findings are free-form JSON on the run row; only well-formed `schema-declined` entries count. */
function asDeclined(value: unknown): DeclinedFinding | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (row.kind !== 'schema-declined') return null;
  if (typeof row.url !== 'string' || typeof row.schemaType !== 'string' || typeof row.reason !== 'string') {
    return null;
  }
  return { url: row.url, schemaType: row.schemaType, reason: row.reason };
}

export const GET = route(async ({ user, request }) => {
  const query = readQuery(request, querySchema);
  const website = await requireScopedWebsite(user, query.websiteId);

  const run = await prisma.agentRun.findFirst({
    where: { websiteId: website.id, agent: 'schema', status: AgentRunStatus.COMPLETED },
    orderBy: { startedAt: 'desc' },
    select: { id: true, startedAt: true, finishedAt: true, summary: true, output: true },
  });

  if (!run) {
    return {
      websiteId: website.id,
      run: null,
      declined: [],
      total: 0,
      byType: {},
      policy: null,
    };
  }

  const output = readJson<SchemaRunOutput>(run.output, {});
  const findings = Array.isArray(output.findings) ? output.findings : [];

  const declined: DeclinedFinding[] = [];
  for (const finding of findings) {
    const parsed = asDeclined(finding);
    if (parsed) declined.push(parsed);
  }

  const byType: Record<string, number> = {};
  for (const entry of declined) byType[entry.schemaType] = (byType[entry.schemaType] ?? 0) + 1;

  return {
    websiteId: website.id,
    run: {
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      summary: run.summary,
    },
    declined: declined.slice(0, query.limit),
    /**
     * The run's own count, which can exceed the stored findings: the agent keeps only the first
     * 30 examples. Reporting the sample length as the total would understate the refusals.
     */
    total: typeof output.data?.declined === 'number' ? output.data.declined : declined.length,
    byType,
    policy: typeof output.data?.policy === 'string' ? output.data.policy : null,
  };
});
