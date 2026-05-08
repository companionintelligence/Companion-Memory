import { Injectable, type OnModuleInit } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import {
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLInputType,
  type GraphQLOutputType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLUnionType,
  isInputObjectType,
  isListType,
  isNonNullType,
  isScalarType,
  isEnumType,
} from 'graphql';
import { z, type ZodTypeAny } from 'zod';

import { LoggerService } from '@ci/common/logging';

import type { McpToolDefinition } from '../types';

@Injectable()
export class McpSchemaService implements OnModuleInit {
  private tools: McpToolDefinition[] = [];

  constructor(
    private readonly schemaHost: GraphQLSchemaHost,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('McpSchemaService');
  }

  onModuleInit() {
    this.buildToolsFromSchema();
  }

  getTools(): McpToolDefinition[] {
    return this.tools;
  }

  private buildToolsFromSchema() {
    const schema = this.schemaHost.schema;

    const queryType = schema.getQueryType();
    const mutationType = schema.getMutationType();

    if (queryType) {
      const fields = queryType.getFields();

      for (const [name, field] of Object.entries(fields)) {
        this.tools.push(this.fieldToTool(name, field, 'query'));
      }
    }

    if (mutationType) {
      const fields = mutationType.getFields();

      for (const [name, field] of Object.entries(fields)) {
        this.tools.push(this.fieldToTool(name, field, 'mutation'));
      }
    }

    this.logger.log('MCP tools built from GraphQL schema', {
      queryTools: queryType ? Object.keys(queryType.getFields()).length : 0,
      mutationTools: mutationType ? Object.keys(mutationType.getFields()).length : 0,
      totalTools: this.tools.length,
    });
  }

  private fieldToTool(
    name: string,
    field: GraphQLField<unknown, unknown>,
    operation: 'query' | 'mutation',
  ): McpToolDefinition {
    const description = this.buildDescription(name, field, operation);
    const inputSchema = this.buildZodShape(field.args);

    return {
      name: `${operation}_${name}`,
      description,
      inputSchema,
      operationName: name,
      operationType: operation,
      graphqlArgs: field.args,
      returnType: field.type,
    };
  }

  private buildDescription(
    name: string,
    field: GraphQLField<unknown, unknown>,
    operation: 'query' | 'mutation',
  ): string {
    const parts: string[] = [];

    // Lead with the author-provided description if available
    if (field.description) {
      parts.push(field.description);
    } else {
      const verb = operation === 'query' ? 'Query' : 'Mutation';
      parts.push(`${verb}: ${name}`);
    }

    // Describe arguments
    if (field.args.length > 0) {
      const argSummaries = field.args.map((arg) => {
        const typeName = this.getNamedInputTypeName(arg.type);
        const required = isNonNullType(arg.type);
        const desc = arg.description ? ` – ${arg.description}` : '';

        return `  ${arg.name} (${typeName}${required ? ', required' : ''})${desc}`;
      });

      parts.push(`\nArgs:\n${argSummaries.join('\n')}`);
    }

    // Describe return type
    const returnDescription = this.describeOutputType(field.type, new Set());
    parts.push(`\nReturns: ${returnDescription}`);

    return parts.join('');
  }

  /**
   * Produce a human-readable description of a GraphQL output type,
   * expanding object types into their fields recursively.
   * Uses a visited set to avoid circular references.
   */
  private describeOutputType(type: GraphQLOutputType, visited: Set<string>): string {
    if (type instanceof GraphQLNonNull) {
      return this.describeOutputType(type.ofType, visited);
    }

    if (type instanceof GraphQLList) {
      return `[${this.describeOutputType(type.ofType, visited)}]`;
    }

    if (type instanceof GraphQLScalarType || type instanceof GraphQLEnumType) {
      return type.name;
    }

    if (type instanceof GraphQLUnionType) {
      return type
        .getTypes()
        .map((t) => this.describeOutputType(t, visited))
        .join(' | ');
    }

    if (type instanceof GraphQLObjectType) {
      if (visited.has(type.name)) {
        return `{ ${Object.keys(type.getFields()).join(', ')} }`;
      }

      visited.add(type.name);

      const fields = type.getFields();
      const fieldLines = Object.entries(fields).map(([fieldName, f]) => {
        const fieldType = this.describeOutputType(f.type, visited);
        const desc = f.description ? ` – ${f.description}` : '';

        return `  ${fieldName}: ${fieldType}${desc}`;
      });

      return `{\n${fieldLines.join('\n')}\n}`;
    }

    return 'Unknown';
  }

  private getNamedInputTypeName(type: GraphQLInputType): string {
    if (isNonNullType(type)) {
      return this.getNamedInputTypeName(type.ofType as GraphQLInputType);
    }

    if (isListType(type)) {
      return `[${this.getNamedInputTypeName(type.ofType as GraphQLInputType)}]`;
    }

    if (isScalarType(type) || isEnumType(type) || isInputObjectType(type)) {
      return type.name;
    }

    return 'Unknown';
  }

  private buildZodShape(args: readonly GraphQLArgument[]): Record<string, ZodTypeAny> {
    const shape: Record<string, ZodTypeAny> = {};

    for (const arg of args) {
      let schema = this.graphqlTypeToZod(arg.type);

      if (arg.description) {
        schema = schema.describe(arg.description);
      }

      shape[arg.name] = schema;
    }

    return shape;
  }

  private graphqlTypeToZod(type: GraphQLInputType): ZodTypeAny {
    if (isNonNullType(type)) {
      return this.graphqlTypeToZod(type.ofType);
    }

    // Non-null types are handled by wrapping above; everything else is optional
    const inner = this.graphqlTypeToZodInner(type);

    return inner.optional();
  }

  private graphqlTypeToZodInner(type: GraphQLInputType): ZodTypeAny {
    if (isNonNullType(type)) {
      return this.graphqlTypeToZodInner(type.ofType);
    }

    if (isListType(type)) {
      return z.array(this.graphqlTypeToZodInner(type.ofType));
    }

    if (isScalarType(type)) {
      return this.scalarToZod(type);
    }

    if (isEnumType(type)) {
      const values = type.getValues().map((v) => v.value as string);

      if (values.length === 0) {
        return z.string();
      }

      return z.enum(values as [string, ...string[]]);
    }

    if (isInputObjectType(type)) {
      return this.inputObjectToZod(type);
    }

    return z.unknown();
  }

  private scalarToZod(scalar: GraphQLScalarType): ZodTypeAny {
    switch (scalar.name) {
      case 'String':
      case 'ID':
      case 'DateTime':
        return z.string();
      case 'Int':
        return z.number().int();
      case 'Float':
        return z.number();
      case 'Boolean':
        return z.boolean();
      case 'JSON':
        return z.unknown();
      default:
        return z.string();
    }
  }

  private inputObjectToZod(type: GraphQLInputObjectType): ZodTypeAny {
    const fields = type.getFields();
    const shape: Record<string, ZodTypeAny> = {};

    for (const [fieldName, field] of Object.entries(fields)) {
      let schema: ZodTypeAny;

      if (isNonNullType(field.type)) {
        schema = this.graphqlTypeToZodInner(field.type);
      } else {
        schema = this.graphqlTypeToZodInner(field.type).optional();
      }

      if (field.description) {
        schema = schema.describe(field.description);
      }

      shape[fieldName] = schema;
    }

    return z.object(shape);
  }

  private getNamedTypeName(type: GraphQLOutputType): string {
    if (type instanceof GraphQLNonNull) {
      return this.getNamedTypeName(type.ofType);
    }

    if (type instanceof GraphQLList) {
      return `[${this.getNamedTypeName(type.ofType)}]`;
    }

    if (
      type instanceof GraphQLObjectType ||
      type instanceof GraphQLScalarType ||
      type instanceof GraphQLEnumType ||
      type instanceof GraphQLUnionType
    ) {
      return type.name;
    }

    return 'Unknown';
  }
}
