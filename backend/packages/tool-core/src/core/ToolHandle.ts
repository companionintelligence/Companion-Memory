import type { ToolRequestContext } from '../context';

import type { IntentDefinition, IntentPrivacy, ToolResult } from './types';

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

  /**
   * The label for THIS call, when the call can do more than the declared label says.
   *
   * One static label per tool has to describe its mildest use: `memory.remember` adds a fact
   * most of the time, and replaces or erases stored data some of the time. Labelled by the first,
   * a write key and the confirmation gate wave through the second. A tool whose reach depends on
   * its input answers here, and the registry runs the capability check, the gate and the ledger
   * on the stricter of this and `schema.privacy` (see {@link stricterPrivacy}), so the answer can
   * only ever tighten what the declared label allows.
   *
   * `input` is what `execute` will receive, after the registry's schema coercion. Answer
   * `undefined` (or the declared label) when the call is no stronger than declared. Optional: a
   * tool whose every call is the same answers nothing and keeps today's behaviour exactly.
   */
  privacyFor?(context: ToolRequestContext, input: unknown): Promise<IntentPrivacy | undefined>;

  execute(context: ToolRequestContext, input: unknown): Promise<ToolResult<TOutput>>;
}
