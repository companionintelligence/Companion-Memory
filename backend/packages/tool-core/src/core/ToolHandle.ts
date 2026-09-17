import type { ToolRequestContext } from '../context';

import type { IntentDefinition, ToolResult } from './types';

/**
 * All the registry needs a tool to be: a schema, and something that runs.
 *
 * `BaseTool` — the abstract class the API's 33 native tools extend, with its uuid execution ids,
 * input sanitizing and error normalization — deliberately stays in the API. It is where a tool
 * meets a `LoggerService` and the rest of the application, and none of that belongs to the rules
 * this package owns. The registry never touches any of it: it reads `schema` and it calls
 * `execute`, so that is exactly what it asks for.
 *
 * {@link ToolRegistryCore} is generic over this so a frontend can keep its own richer tool type
 * end-to-end — the API instantiates it as `ToolRegistryCore<BaseTool>`, and `getTool` there still
 * returns a `BaseTool`.
 */
export interface ToolHandle<TOutput = unknown> {
  /** Every tool is an intent; the schema IS the curated intent definition. */
  readonly schema: IntentDefinition;

  execute(context: ToolRequestContext, input: unknown): Promise<ToolResult<TOutput>>;
}
