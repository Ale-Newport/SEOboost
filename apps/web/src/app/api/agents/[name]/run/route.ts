import { z } from 'zod';
import { NotFoundError, createLogger } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { isAiAvailable } from '@seo/ai';
import { readBody, route } from '@/lib/api';
import { enqueueSummary, requireScopedWebsite, skipped } from '@/app/api/_lib/common';
import { findAgent } from '@/app/api/_lib/agents';

const log = createLogger('api:agents');

/**
 * `POST /api/agents/[name]/run`.
 *
 * The `AgentRun` row is created here rather than in the worker so the UI can follow the run
 * from the moment the button is pressed. That creates one obligation: if the enqueue fails —
 * no broker — the row is closed as FAILED immediately, because a RUNNING row that no worker
 * will ever touch is a lie the Jobs screen would keep telling.
 */

const bodySchema = z.object({
  websiteId: z.string().trim().min(1),
  /** Agent-specific parameters (page ids, keyword ids, limits…). */
  input: z.record(z.string(), z.unknown()).default({}),
});

export const POST = route<{ name: string }>(async ({ user, request, params }) => {
  const body = await readBody(request, bodySchema);
  const website = await requireScopedWebsite(user, body.websiteId);

  const agent = findAgent(params.name);
  if (!agent) throw new NotFoundError(`Agent "${params.name}"`);

  if (agent.requiresAi && !isAiAvailable()) {
    return skipped(
      `${agent.label} needs a configured AI provider and this installation has none.`,
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY, then run the agent again.',
    );
  }

  /*
   * No AgentRun row is created here.
   *
   * The agent runtime owns run rows, and pre-creating a placeholder produced two rows for every
   * manual run — the runs screen then read as if the agent had executed twice. The JobRecord
   * returned below is what the UI follows between enqueue and execution; the runtime writes the
   * single authoritative AgentRun when the worker picks the job up.
   */
  const result = await enqueue(
    'agents.run',
    {
      websiteId: website.id,
      agent: agent.key,
      trigger: 'manual',
      input: body.input,
    },
    { websiteId: website.id, trigger: 'manual', dedupeKey: `agents.run:${agent.key}:${website.id}` },
  );

  const job = enqueueSummary(result);

  log.info('agent run queued', { agent: agent.key, websiteId: website.id, enqueued: job.enqueued });

  return {
    agent: { key: agent.key, name: agent.name, label: agent.label },
    job,
  };
});
