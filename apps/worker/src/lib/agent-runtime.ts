/**
 * The bridge from a queued job to `@seo/agents`.
 *
 * The agent package is loaded through a *dynamic* import for one reason: a deployment that
 * ships only the crawler and the analysis lanes (no agents, no AI keys) must still boot and
 * still run every deterministic job. A static import would make the whole worker process fail
 * to start because one optional capability is absent. So this module resolves the package once,
 * caches the answer, and turns "not installed" into the same typed `skipped` result the rest of
 * the worker uses for a missing integration.
 *
 * The structural contract below mirrors `runAgent` in `@seo/agents`; it is validated at
 * runtime before the function is called, so a signature drift surfaces as a readable job error
 * instead of a `TypeError` in a stack trace.
 */

import { createLogger, errorMessage } from '@seo/shared';
import type { AgentResult } from '@seo/agents/types';

const log = createLogger('worker:agents');

/** Resolved at runtime; a literal specifier would be a hard build-time dependency. */
const AGENTS_MODULE = '@seo/agents';

export type AgentTrigger = 'manual' | 'scheduled' | 'workflow' | 'agent';

export interface AgentRunRequest {
  agent: string;
  websiteId: string;
  input?: Record<string, unknown>;
  trigger?: AgentTrigger;
  userId?: string | null;
  signal?: AbortSignal;
}

/** The subset of `AgentRunOutcome` the worker persists and reports. */
export interface AgentOutcome {
  runId: string | null;
  agent: string;
  status: string;
  ok: boolean;
  skipped: boolean;
  skipReason: string | null;
  result: AgentResult | null;
  error: string | null;
  retryable: boolean;
  durationMs: number;
  usage: { provider: string | null; model: string | null; tokensIn: number; tokensOut: number; costUsd: number };
}

export type AgentDispatch =
  | { available: true; outcome: AgentOutcome }
  | { available: false; reason: string };

type RunAgentFn = (name: string, options: {
  websiteId: string;
  userId?: string | null;
  trigger?: AgentTrigger;
  input?: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<unknown>;

interface AgentModule {
  runAgent: RunAgentFn;
  listAgents?: () => Array<{ name: string; label?: string; requiresAi?: boolean }>;
}

let cached: AgentModule | null = null;
let loadError: string | null = null;

/**
 * Loads `@seo/agents` once. A failure is remembered so a worker without the package does not
 * pay a module-resolution error on every job.
 */
async function loadAgentModule(): Promise<AgentModule | null> {
  if (cached) return cached;
  if (loadError) return null;

  let loaded: unknown;
  try {
    loaded = await import(AGENTS_MODULE);
  } catch (err) {
    loadError = errorMessage(err);
    log.warn('agent package could not be loaded; agent jobs will report as skipped', {
      error: loadError,
    });
    return null;
  }

  if (typeof loaded !== 'object' || loaded === null || typeof (loaded as AgentModule).runAgent !== 'function') {
    loadError = 'The @seo/agents package does not export a runAgent(name, options) function.';
    log.error('agent package has an unexpected shape', { error: loadError });
    return null;
  }

  // Guarded by the check above: the module exposes the function this worker calls.
  cached = loaded as AgentModule;
  return cached;
}

/** Every agent the package registered, or an empty list when it is not installed. */
export async function listAvailableAgents(): Promise<string[]> {
  const module = await loadAgentModule();
  if (!module?.listAgents) return [];
  try {
    return module.listAgents().map((agent) => agent.name);
  } catch (err) {
    log.warn('could not list agents', { error: errorMessage(err) });
    return [];
  }
}

function readOutcome(value: unknown, agent: string): AgentOutcome {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const usage = (typeof raw.usage === 'object' && raw.usage !== null ? raw.usage : {}) as Record<string, unknown>;
  const result = (typeof raw.result === 'object' && raw.result !== null ? (raw.result as AgentResult) : null);

  return {
    runId: typeof raw.runId === 'string' ? raw.runId : null,
    agent: typeof raw.agent === 'string' ? raw.agent : agent,
    status: typeof raw.status === 'string' ? raw.status : 'COMPLETED',
    ok: raw.ok === true,
    skipped: raw.skipped === true || result?.skipped === true,
    skipReason:
      typeof raw.skipReason === 'string'
        ? raw.skipReason
        : typeof result?.skipReason === 'string'
          ? result.skipReason
          : null,
    result,
    error: typeof raw.error === 'string' ? raw.error : null,
    retryable: raw.retryable === true,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
    usage: {
      provider: typeof usage.provider === 'string' ? usage.provider : null,
      model: typeof usage.model === 'string' ? usage.model : null,
      tokensIn: typeof usage.tokensIn === 'number' ? usage.tokensIn : 0,
      tokensOut: typeof usage.tokensOut === 'number' ? usage.tokensOut : 0,
      costUsd: typeof usage.costUsd === 'number' ? usage.costUsd : 0,
    },
  };
}

/**
 * Runs one agent. Never throws for a missing package — that is `available: false`, which the
 * caller turns into a skipped job result naming what to install.
 */
export async function dispatchAgent(request: AgentRunRequest): Promise<AgentDispatch> {
  const module = await loadAgentModule();
  if (!module) {
    return {
      available: false,
      reason:
        loadError ??
        'The @seo/agents package is not available in this deployment, so agent jobs cannot run.',
    };
  }

  const raw = await module.runAgent(request.agent, {
    websiteId: request.websiteId,
    userId: request.userId ?? null,
    trigger: request.trigger ?? 'workflow',
    input: request.input ?? {},
    ...(request.signal ? { signal: request.signal } : {}),
  });

  return { available: true, outcome: readOutcome(raw, request.agent) };
}
