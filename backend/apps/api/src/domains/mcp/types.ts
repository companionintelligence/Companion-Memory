import type { GraphQLArgument, GraphQLOutputType } from 'graphql';
import type { ZodTypeAny } from 'zod';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, ZodTypeAny>;
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
  source: McpToolSource;
}
