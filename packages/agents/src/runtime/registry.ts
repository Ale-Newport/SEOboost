import { prisma } from '@seo/db';
import { ForbiddenError, NotFoundError, createLogger } from '@seo/shared';
import type { AgentContext, AgentDefinition } from '../types';

const log = createLogger('agents:registry');

/**
 * Type-erased agent record.
 *
 * Every agent declares its own input shape, but the only member the runtime ever calls is
 * `run(context)` — which does not mention that shape — so the registry stores one erased type.
 * `runAgent` re-validates raw input against `inputSchema` before the agent sees it, so nothing
 * is weakened by the erasure.
 */
export type RegisteredAgent = AgentDefinition<Record<string, unknown>>;

const agents = new Map<string, RegisteredAgent>();

/**
 * Which agent owns which `AgentRun`.
 *
 * Tools and `createActionFromAgent` are handed an `AgentContext`, which carries a `runId` but not
 * the agent identity — yet both need the identity to enforce the agent's declared tool and action
 * allow-lists. `runAgent` binds the run here for the duration of the call; anything that resolves
 * later (a resumed worker, an agent invoked from another process) falls back to the `AgentRun`
 * row and is then cached in this same map.
 */
const runOwners = new Map<string, string>();

/**
 * Runs whose owner was recovered from the database rather than bound by `runAgent`.
 *
 * Kept apart from `runOwners` and capped: nothing ever unbinds these (the run was started in
 * another process, so this process never sees it finish), and an uncapped map in a worker that
 * lives for weeks is a slow leak. Oldest entry is evicted first — a run whose tools are still
 * calling is by definition the most recently used one.
 */
const RESOLVED_CACHE_LIMIT = 256;
const resolvedOwners = new Map<string, string>();

function rememberResolvedOwner(runId: string, agentName: string): void {
  // Re-insert so the key moves to the end of the insertion order (LRU on write).
  resolvedOwners.delete(runId);
  resolvedOwners.set(runId, agentName);
  while (resolvedOwners.size > RESOLVED_CACHE_LIMIT) {
    const oldest = resolvedOwners.keys().next();
    if (oldest.done) break;
    resolvedOwners.delete(oldest.value);
  }
}

/** Agents self-register on import. Re-registering the same name replaces it (module reloads). */
export function registerAgent<TInput>(definition: AgentDefinition<TInput>): RegisteredAgent {
  // See the RegisteredAgent doc comment: TInput never appears in `run`, so erasing it is sound.
  // A direct `as RegisteredAgent` is rejected because ZodType is invariant in its input type.
  const erased = definition as unknown as RegisteredAgent;
  if (agents.has(definition.name)) {
    log.debug('replacing an already-registered agent', { agent: definition.name });
  }
  agents.set(definition.name, erased);
  return erased;
}

/**
 * Normalise an agent identifier so the registry answers to every form in circulation.
 *
 * Agents register under their canonical `AgentName` (`AnalyticsAgent`), but the API addresses
 * them by a stable kebab key in URLs and `agents.run` payloads (`analytics`), and historical
 * `AgentRun` rows contain both. Resolving on a normalised key means a job enqueued by the web
 * app actually finds its agent in the worker — previously it did not, and every agent run failed
 * with "No agent named …" the moment it left the HTTP process.
 */
function normaliseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/agent$/, '');
}

export function findAgent(name: string): RegisteredAgent | undefined {
  const direct = agents.get(name);
  if (direct) return direct;

  const wanted = normaliseKey(name);
  if (!wanted) return undefined;
  for (const agent of agents.values()) {
    if (normaliseKey(agent.name) === wanted) return agent;
  }
  return undefined;
}

/** Throws rather than returning undefined: an unknown agent name is a programming error. */
export function getAgent(name: string): RegisteredAgent {
  const agent = findAgent(name);
  if (!agent) throw new NotFoundError(`Agent "${name}"`);
  return agent;
}

export function listAgents(): RegisteredAgent[] {
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function isAgentRegistered(name: string): boolean {
  return findAgent(name) !== undefined;
}

/** Test seam. Production code never clears the registry. */
export function resetAgentRegistry(): void {
  agents.clear();
  runOwners.clear();
  resolvedOwners.clear();
}

export function bindRunToAgent(runId: string, agentName: string): void {
  runOwners.set(runId, agentName);
}

export function unbindRun(runId: string): void {
  runOwners.delete(runId);
  resolvedOwners.delete(runId);
}

export function getBoundAgentName(runId: string): string | undefined {
  return runOwners.get(runId) ?? resolvedOwners.get(runId);
}

/**
 * Identify the agent responsible for a context, so its allow-lists can be enforced.
 *
 * Fails closed: a context whose run cannot be attributed to a registered agent gets no tools and
 * no action-creation rights. That is deliberate — an unattributable caller is exactly the case
 * where guardrails matter most.
 */
export async function resolveCallingAgent(context: AgentContext): Promise<RegisteredAgent> {
  const bound = context.runId ? getBoundAgentName(context.runId) : undefined;
  if (bound) {
    const agent = agents.get(bound);
    if (agent) return agent;
  }

  if (!context.runId) {
    throw new ForbiddenError(
      'This call has no agent run attached, so no agent permissions can be resolved. Start it through runAgent().',
    );
  }

  const row = await prisma.agentRun.findUnique({
    where: { id: context.runId },
    select: { agent: true },
  });
  const agent = row ? agents.get(row.agent) : undefined;
  if (!agent) {
    throw new ForbiddenError(
      `Agent run ${context.runId} is not attributable to a registered agent${
        row ? ` (row says "${row.agent}")` : ''
      }, so tool and action permissions cannot be checked.`,
    );
  }

  rememberResolvedOwner(context.runId, agent.name);
  return agent;
}
