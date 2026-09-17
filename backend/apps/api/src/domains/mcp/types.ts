import type { GraphQLArgument, GraphQLOutputType } from 'graphql';
import type { ZodTypeAny } from 'zod';

import type { IntentPrivacy } from '@ci/domains/tools';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  /**
   * Synthesized privacy/safety label. Auto-wrapped GraphQL CRUD historically carried no label,
   * letting mutations bypass the intent layer's guarantees; every advertised tool now carries one.
   */
  privacy: IntentPrivacy;
  operationName: string;
  operationType: 'query' | 'mutation';
  graphqlArgs: readonly GraphQLArgument[];
  returnType: GraphQLOutputType;
}

export type McpToolSource = 'graphql' | 'native';

export interface McpRegisteredTool {
  name: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
  /** Privacy/safety label carried through to MCP tool annotations. Never undefined. */
  privacy: IntentPrivacy;
  source: McpToolSource;
}

/**
 * A tool failure carried across a `throw` with its structure intact.
 *
 * The MCP plane used to do `throw new Error(result.error?.message)`, which
 * destroyed `code` and `details` — and `details` is where the approval queue
 * puts `pendingActionId`. So a queued action reached the harness as an opaque
 * sentence with nothing to act on, while the dispatch packet's own stop rule
 * tells it to "report blocked, name the pendingActionId, and stop".
 *
 * The REST intent path returns the whole `ToolError` in its body, and both
 * harness plugins read `error.code` and `error.details.pendingActionId` from
 * it. This exists so the MCP plane can present the SAME shape rather than a
 * second, lossier dialect of the same event.
 */
export class ToolExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ToolExecutionError';
  }
}
