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
  printSchema,
} from 'graphql';
import { z, type ZodTypeAny } from 'zod';

import { LoggerService } from '@ci/common/logging';
import type { IntentPrivacy } from '@ci/domains/tools';

import type { McpToolDefinition } from '../types';

/**
 * Mutation name prefixes that remove or overwrite data. Auto-wrapped tools matching these are
 * labelled `destructive` so the enforcing dispatcher confirms/audits before running them, matching
 * the treatment of the native `memory.forget` intent.
 */
const DESTRUCTIVE_MUTATION_PREFIXES = ['delete', 'remove', 'destroy', 'purge', 'drop'] as const;

@Injectable()
export class GraphQLToolAdapter implements OnModuleInit {
  private tools: McpToolDefinition[] = [];

  constructor(
    private readonly schemaHost: GraphQLSchemaHost,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext('GraphQLToolAdapter');
  }

  onModuleInit() {
    this.buildToolsFromSchema();
  }

  getTools(): McpToolDefinition[] {
    return this.tools;
  }

  getSchemaSDL(): string {
    return printSchema(this.schemaHost.schema);
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
      privacy: this.synthesizePrivacy(name, operation),
      operationName: name,
      operationType: operation,
      graphqlArgs: field.args,
      returnType: field.type,
    };
  }

  /**
   * Synthesize a privacy/safety label for an auto-wrapped GraphQL root field. These tools are
   * generated from the schema and carry no hand-authored {@link IntentPrivacy}; without a label
   * they slip past the intent layer's dispatcher entirely. We derive a conservative label from the
   * operation kind and field name:
   *
   * - queries → read access, non-destructive;
   * - mutations → write access, unless the name matches a {@link DESTRUCTIVE_MUTATION_PREFIXES}
   *   pattern (e.g. `deleteMemory`), in which case it is `delete`/`destructive`;
   * - all wrapped operations are internal CRUD against local Companion Memory, so `external: false`.
   *
   * Sensitivity defaults to `personal` — memory data is personal by default; a dispatcher can
   * downgrade specific safe fields later.
   */
  private synthesizePrivacy(name: string, operation: 'query' | 'mutation'): IntentPrivacy {
    if (operation === 'query') {
      return {
        access: 'read',
        sensitivity: 'personal',
        destructive: false,
        external: false,
      };
    }

    const lowerName = name.toLowerCase();
    const destructive = DESTRUCTIVE_MUTATION_PREFIXES.some((prefix) =>
      lowerName.startsWith(prefix),
    );

    return {
      access: destructive ? 'delete' : 'write',
      sensitivity: 'personal',
      destructive,
      external: false,
    };
  }

  private buildDescription(
    name: string,
    field: GraphQLField<unknown, unknown>,
    operation: 'query' | 'mutation',
  ): string {
    const parts: string[] = [];

    // Lead with the documented description if available
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
   * Produce a human-readable description of a GraphQL output type, expanding
   * object types into their fields recursively. Uses a visited set to avoid
   * circular references.
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
      return this.graphqlTypeToZodInner(type.ofType);
    }

    return this.graphqlTypeToZodInner(type).optional();
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
}
