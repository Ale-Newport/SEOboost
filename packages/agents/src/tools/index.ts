import { AppError, ForbiddenError, NotFoundError, ValidationError, createLogger, errorMessage } from '@seo/shared';
import type { AgentContext, ToolDefinition } from '../types';
import { resolveCallingAgent } from '../runtime/registry';
import type { AnyToolDefinition } from './define';
import { readTools } from './read';
import { writeTools } from './write';

const log = createLogger('agents:tools');

const tools = new Map<string, AnyToolDefinition>();

/**
 * The tool registry.
 *
 * Tools are the *only* way an agent reads or writes platform state. That is a deliberate
 * bottleneck: it is where the site scope, the per-agent allow-list, argument validation and the
 * run transcript all get applied, and none of them can be skipped by an agent that decides to
 * reach for `prisma` on its own.
 */
export function registerTool<TArgs, TResult>(tool: ToolDefinition<TArgs, TResult>): void {
  if (tools.has(tool.name)) {
    log.debug('replacing an already-registered tool', { tool: tool.name });
  }
  // Same erasure as `defineTool`: the registry parses args with this tool's own schema and hands
  // the parsed value back to this tool's own execute, so the pairing never crosses tools.
  tools.set(tool.name, tool as unknown as AnyToolDefinition);
}

export function findTool(name: string): AnyToolDefinition | undefined {
  return tools.get(name);
}

export function getTool(name: string): AnyToolDefinition {
  const tool = tools.get(name);
  if (!tool) throw new NotFoundError(`Tool "${name}"`);
  return tool;
}

export function listTools(): AnyToolDefinition[] {
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Names only — handy when building an agent definition's `tools` list. */
export function listToolNames(): string[] {
  return listTools().map((tool) => tool.name);
}

/** Test seam. Production code never clears the registry. */
export function resetToolRegistry(): void {
  tools.clear();
}

/**
 * Invoke a tool on behalf of an agent.
 *
 * Order matters: the calling agent is resolved and its allow-list checked *before* the arguments
 * are parsed, so a tool an agent may not use never sees its input at all. Both the success and
 * the failure are written to the run transcript, because a run where a tool blew up is exactly
 * the run an operator will want to read.
 *
 * A cancelled run is refused here too. `runAgent` only checks the signal around the agent body,
 * so without this a run the operator stopped would keep proposing actions and writing rows until
 * the agent happened to return.
 *
 * `TResult` is a convenience for the caller — the registry stores tools with their result type
 * erased, so annotate it with the result interface the tool documents.
 */
export async function runTool<TResult = unknown>(
  name: string,
  args: unknown,
  context: AgentContext,
): Promise<TResult> {
  const tool = getTool(name);

  if (context.signal?.aborted) {
    throw new AppError(`Run cancelled before "${name}" could be called.`, {
      code: 'CANCELLED',
      status: 499,
    });
  }

  const agent = await resolveCallingAgent(context);

  if (!agent.tools.includes(name)) {
    throw new ForbiddenError(
      `${agent.name} may not call the "${name}" tool. Declared tools: ${agent.tools.join(', ') || 'none'}.`,
    );
  }

  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid arguments for tool "${name}": ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`,
      parsed.error.issues,
    );
  }

  const startedAt = Date.now();
  try {
    const result = await tool.execute(parsed.data, context);
    context.recordToolCall(name, parsed.data, result, Date.now() - startedAt);
    return result as TResult;
  } catch (err) {
    const message = errorMessage(err);
    context.recordToolCall(name, parsed.data, { error: message }, Date.now() - startedAt);
    log.warn('tool call failed', { tool: name, agent: agent.name, error: message });
    throw err;
  }
}

for (const tool of [...readTools, ...writeTools]) registerTool(tool);

export type { AnyToolDefinition } from './define';
export { defineTool } from './define';
export * from './read';
export * from './write';
