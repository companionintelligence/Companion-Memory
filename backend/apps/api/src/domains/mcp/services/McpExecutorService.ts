import { Injectable } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import {
  type DocumentNode,
  type GraphQLArgument,
  type GraphQLInputType,
  type GraphQLOutputType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  execute,
  parse,
  isNonNullType,
  isObjectType,
  isScalarType,
  isEnumType,
  isUnionType,
} from 'graphql';

import { LoggerService } from '@ci/common/logging';

import type { McpToolDefinition } from '../types';

@Injectable()
export class McpExecutorService {
  constructor(
    private readonly schemaHost: GraphQLSchemaHost,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('McpExecutorService');
  }

  async executeTool(
    tool: McpToolDefinition,
    args: Record<string, unknown>,
    contextValue: Record<string, unknown>,
  ): Promise<unknown> {
    const selectionSet = this.buildSelectionSet(tool.returnType, 2);
    const variableDefinitions = this.buildVariableDefinitions(tool.graphqlArgs);
    const variableArgs = this.buildVariableArgs(tool.graphqlArgs);

    const operationKeyword = tool.operationType === 'query' ? 'query' : 'mutation';

    const queryString = variableDefinitions
      ? `${operationKeyword} McpOp(${variableDefinitions}) { ${tool.operationName}(${variableArgs})${selectionSet} }`
      : `${operationKeyword} McpOp { ${tool.operationName}${selectionSet} }`;

    let document: DocumentNode;

    try {
      document = parse(queryString);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      this.logger.error(error, `Failed to parse generated query for tool ${tool.name}`);

      throw new Error(`Internal error building query for tool ${tool.name}`);
    }

    const result = await execute({
      schema: this.schemaHost.schema,
      document,
      variableValues: args,
      contextValue,
    });

    if (result.errors && result.errors.length > 0) {
      const messages = result.errors.map((e) => e.message).join('; ');

      this.logger.warn(`GraphQL errors executing tool ${tool.name}: ${messages}`);

      return {
        errors: result.errors.map((e) => ({
          message: e.message,
          path: e.path,
        })),
        data: result.data?.[tool.operationName] ?? null,
      };
    }

    return result.data?.[tool.operationName] ?? null;
  }

  private buildSelectionSet(type: GraphQLOutputType, depth: number): string {
    const unwrapped = this.unwrapType(type);

    if (isScalarType(unwrapped) || isEnumType(unwrapped)) {
      return '';
    }

    if (isUnionType(unwrapped)) {
      const members = unwrapped.getTypes();
      const fragments = members
        .map((member) => {
          const fields = this.selectFields(member, depth - 1);

          return fields ? ` ... on ${member.name} { ${fields} }` : '';
        })
        .filter(Boolean)
        .join('');

      return fragments ? ` {${fragments} }` : '';
    }

    if (isObjectType(unwrapped)) {
      const fields = this.selectFields(unwrapped, depth);

      return fields ? ` { ${fields} }` : '';
    }

    return '';
  }

  private selectFields(type: GraphQLObjectType, depth: number): string {
    if (depth <= 0) {
      const fields = type.getFields();

      // At depth 0, only include scalar/enum fields
      return Object.entries(fields)
        .filter(([, f]) => {
          const inner = this.unwrapType(f.type);

          return isScalarType(inner) || isEnumType(inner);
        })
        .map(([name]) => name)
        .join(' ');
    }

    const fields = type.getFields();
    const parts: string[] = [];

    for (const [name, field] of Object.entries(fields)) {
      const inner = this.unwrapType(field.type);

      if (isScalarType(inner) || isEnumType(inner)) {
        parts.push(name);
      } else if (isObjectType(inner) || isUnionType(inner)) {
        const nested = this.buildSelectionSet(field.type, depth - 1);

        if (nested) {
          // If the field requires arguments (like connection fields), pass reasonable defaults
          const requiredArgs = field.args.filter((a) => isNonNullType(a.type));

          if (requiredArgs.length > 0) {
            // Skip fields that require arguments we can't provide automatically
            continue;
          }

          parts.push(`${name}${nested}`);
        }
      }
    }

    return parts.join(' ');
  }

  private buildVariableDefinitions(args: readonly GraphQLArgument[]): string | null {
    if (args.length === 0) {
      return null;
    }

    return args.map((arg) => `$${arg.name}: ${arg.type.toString()}`).join(', ');
  }

  private buildVariableArgs(args: readonly GraphQLArgument[]): string {
    if (args.length === 0) {
      return '';
    }

    return args.map((arg) => `${arg.name}: $${arg.name}`).join(', ');
  }

  private unwrapType(type: GraphQLOutputType | GraphQLInputType): GraphQLOutputType {
    if (type instanceof GraphQLNonNull || type instanceof GraphQLList) {
      return this.unwrapType(type.ofType);
    }

    return type as GraphQLOutputType;
  }
}
