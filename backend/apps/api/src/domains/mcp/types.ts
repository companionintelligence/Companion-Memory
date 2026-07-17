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
