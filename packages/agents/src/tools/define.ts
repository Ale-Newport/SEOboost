import type { ToolDefinition } from '../types';

/**
 * A tool as the registry stores it, with its argument and result types erased.
 *
 * The registry is heterogeneous by nature — every tool has its own arg shape — and the runtime
 * only ever does two things with a tool: parse `unknown` args through its schema, then hand the
 * parsed value straight to its own `execute`. That pairing is what keeps the erasure sound, and
 * it is enforced in `runTool`, which is the only code allowed to call `execute`.
 */
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

/**
 * Declare a tool with full type inference at the definition site, store it erased.
 *
 * Authors get `args` typed from the Zod schema inside `execute`; callers get `unknown` and must
 * go through `runTool`. Zod's `ZodType` is invariant in its input parameter, which is why the
 * widening needs an explicit cast rather than plain assignment.
 */
export function defineTool<TArgs, TResult>(tool: ToolDefinition<TArgs, TResult>): AnyToolDefinition {
  return tool as unknown as AnyToolDefinition;
}
