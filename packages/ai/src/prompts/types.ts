import type { ModelRole } from '../types';

/**
 * Versioned prompt templates.
 *
 * Prompts are the product's actual logic, so they are declared as data with an id and a
 * version instead of being interpolated inline at call sites. That buys three things:
 * the operator can see exactly what the platform asks a model, output regressions can be
 * traced to a version bump, and `render()` stays pure and unit-testable.
 */

export interface PromptTemplateMeta {
  /** Stable kebab-case id. Also used as the `AiUsage.task` label by convention. */
  id: string;
  /** Bump on every material edit to the system prompt or the rendered shape. */
  version: number;
  /** One line explaining what this prompt is for; shown in the prompt inspector. */
  description: string;
  /** The system prompt: role, expertise, hard rules. Constant across calls. */
  system: string;
  /** Suggested routing class. Callers may override. */
  defaultRole?: ModelRole;
}

export interface PromptTemplate<TVars> extends PromptTemplateMeta {
  /**
   * Build the user turn from typed variables. Must be pure — no clocks, no I/O, no randomness
   * — so a rendered prompt can be snapshot-tested and reproduced from stored inputs.
   */
  render(vars: TVars): string;
}

/**
 * Storage type for the heterogeneous registry. `render` is declared as a method, so TypeScript
 * treats its parameter bivariantly and a `PromptTemplate<SpecificVars>` is assignable here
 * without a cast. Callers that want type safety import the exported template const directly.
 */
export type RegisteredPrompt = PromptTemplate<unknown>;
