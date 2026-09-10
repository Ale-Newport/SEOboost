import type { z } from 'zod';

/**
 * The agent contract.
 *
 * An agent is NOT "a big prompt". Every agent runs the same three-phase shape:
 *   1. `gather`   — deterministic data collection through typed tools (no LLM).
 *   2. `reason`   — a single, tightly-scoped LLM call with a structured output schema.
 *   3. `act`      — deterministic persistence: create SeoActions, Approvals, opportunities…
 * Phase 2 is optional: several agents are fully deterministic and never call an LLM at all,
 * which keeps them free, fast and reproducible.
 */

export type AgentName =
  | 'TechnicalSEOAgent'
  | 'KeywordAgent'
  | 'ContentStrategyAgent'
  | 'ContentWriterAgent'
  | 'ContentRefreshAgent'
  | 'InternalLinkAgent'
  | 'SchemaAgent'
  | 'CompetitorAgent'
  | 'GEOAgent'
  | 'AIVisibilityAgent'
  | 'IndexationAgent'
  | 'AnalyticsAgent'
  | 'SEOManagerAgent';

export interface AgentContext {
  websiteId: string;
  /** Set when the run was started by a user rather than the scheduler. */
  userId?: string | null;
  trigger: 'manual' | 'scheduled' | 'workflow' | 'agent';
  /** Persisted AgentRun row id; tools attach their calls to it. */
  runId: string;
  /** Cooperative cancellation from the Jobs screen. */
  signal?: AbortSignal;
  /** Free-form parameters supplied by the caller (page ids, keyword ids, limits…). */
  input: Record<string, unknown>;
  /** Records a tool invocation for the run transcript shown in the UI. */
  recordToolCall(name: string, args: unknown, result: unknown, durationMs: number): void;
  log(message: string, meta?: Record<string, unknown>): void;
}

export interface AgentResult {
  summary: string;
  /** 0-1 self-assessed confidence in the run's conclusions. */
  confidence: number;
  /** Ids of SeoAction rows this run created. */
  actionsCreated: string[];
  /** Ids of Approval rows this run created. */
  approvalsCreated: string[];
  /** Anything the UI should render as findings, keyed by agent. */
  findings: unknown[];
  /** Structured payload persisted on the AgentRun row. */
  data: Record<string, unknown>;
  /** True when the agent could not run because a prerequisite is missing (no crawl, no AI key…). */
  skipped?: boolean;
  skipReason?: string;
}

export interface AgentDefinition<TInput = Record<string, unknown>> {
  name: AgentName;
  label: string;
  /** One sentence shown in the UI describing what this agent is responsible for. */
  description: string;
  /** Which action types this agent is permitted to create. Enforced, not advisory. */
  allowedActionTypes: string[];
  /** Tool names this agent may call. Enforced by the tool runtime. */
  tools: string[];
  /** Does this agent need a configured AI provider to do anything useful? */
  requiresAi: boolean;
  inputSchema?: z.ZodType<TInput>;
  run(context: AgentContext): Promise<AgentResult>;
}

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<TArgs>;
  /** Read-only tools are safe for any agent; write tools are gated by allowedActionTypes. */
  readOnly: boolean;
  execute(args: TArgs, context: AgentContext): Promise<TResult>;
}
