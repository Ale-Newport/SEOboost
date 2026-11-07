import { isAiAvailable } from '@seo/ai';
import { ValidationError } from '@seo/shared';
import { enqueue } from '@seo/queue';
import { route } from '@/lib/api';
import { assertNotReadOnly, enqueueSummary, skipped } from '@/app/api/_lib/common';
import { requireOwnedConversation } from '@/app/api/_lib/social';

/**
 * `POST /api/social/conversations/[id]/draft` — ask the reply agent to draft for this one thread.
 *
 * The draft lands in Approvals like any agent proposal; nothing is posted from here. The agent
 * re-checks every guardrail (caps, community rules, thread age) and may decline to draft, in
 * which case its reason shows up on the conversation.
 */
export const POST = route<{ id: string }>(async ({ user, params }) => {
  await assertNotReadOnly();
  const conversation = await requireOwnedConversation(user, params.id);
  if (['REPLIED', 'DISMISSED', 'EXPIRED'].includes(conversation.status)) {
    throw new ValidationError(`This thread is ${conversation.status.toLowerCase()}; restore it before drafting a reply.`);
  }
  if (!isAiAvailable()) {
    return skipped(
      'Drafting a reply needs an AI provider and this installation has none.',
      'Set OPENAI_API_KEY, ANTHROPIC_API_KEY or GOOGLE_AI_API_KEY — or write the reply yourself with "Write reply".',
    );
  }

  // A minute bucket in the key: a second click inside a minute is collapsed, a deliberate
  // re-draft later is not swallowed by a completed job that still holds the same id.
  const bucket = Math.floor(Date.now() / 60_000);
  const result = await enqueue(
    'agents.run',
    {
      websiteId: conversation.websiteId,
      agent: 'social-engagement',
      trigger: 'manual',
      input: { conversationIds: [conversation.id] },
    },
    { websiteId: conversation.websiteId, trigger: 'manual', dedupeKey: `agents.run:social-engagement:${conversation.id}:${bucket}` },
  );
  return { job: enqueueSummary(result) };
});
