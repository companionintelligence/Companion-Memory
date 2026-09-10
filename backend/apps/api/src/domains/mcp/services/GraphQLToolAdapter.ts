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
import { GRAPHQL_PRIVACY_EXTENSION, type IntentPrivacy } from '@ci/domains/tools';

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
      privacy: this.synthesizePrivacy(name, field, operation),
      operationName: name,
      operationType: operation,
      graphqlArgs: field.args,
      returnType: field.type,
    };
  }

  /**
   * The privacy/safety label for an auto-wrapped GraphQL root field.
   *
   * A DECLARED label wins. `@GraphqlPrivacy` writes one onto the field's
   * `extensions`, which is the only channel that survives schema construction —
   * the adapter never sees the resolver class, so Reflect metadata would be
   * invisible here. Fields that declare nothing fall back to the name heuristic
   * below.
   *
   * The heuristic is kept, but demoted, because it is wrong in both directions
   * and cannot be repaired by lengthening the word list:
   *
   * - `returnEventToSlate` ends in `eventService.remove` and its SDL says
   *   "deleting the event it minted", yet started with none of the prefixes. A
   *   `write` key refused `deleteEvent` could delete the same row through it.
   * - `mergePeople`/`mergeItems`/`mergePlaces` tombstone their sources and drop
   *   the sources' search rows, one-way, at `write`.
   * - `untagEntities` deletes join rows in bulk at `write`, while `deleteTag`
   *   — a single label — costs `full`. The heuristic inverted the severity.
   * - and a verb denylist would misfire the other way: `forageReset` reads like
   *   a wipe and writes nothing at all.
   *
   * The deletion is typically one or two hops down inside a service, where no
   * name-based rule can reach it. So: declare the truth at the resolver, and let
   * the prefix cover the ordinary `deleteX` CRUD it was always right about.
   *
   * - queries → read access, non-destructive;
   * - mutations → write, unless declared otherwise or the name matches a
   *   {@link DESTRUCTIVE_MUTATION_PREFIXES} pattern, in which case
   *   `delete`/`destructive`.
   *
   * `external` defaults to false — most wrapped operations are local CRUD — but
   * it is NOT unconditional any more. The previous blanket `external: false`
   * was untrue of `sendPeerAsk`, `runAsk` and `createConnection`, which reach
   * another Companion or a third party, and it surfaced to MCP clients as
   * `openWorldHint: false`. Those fields declare it.
   *
   * Sensitivity defaults to `personal` — memory data is personal by default.
   */
  private synthesizePrivacy(
    name: string,
    field: GraphQLField<unknown, unknown>,
    operation: 'query' | 'mutation',
  ): IntentPrivacy {
    const declared = field.extensions?.[GRAPHQL_PRIVACY_EXTENSION] as Partial<IntentPrivacy> | undefined;

    const inferred = this.inferPrivacy(name, operation);

    if (!declared) {
      return inferred;
    }

    // A declaration overrides field by field, so a resolver can correct one axis
    // (`external`) without restating the rest. `destructive` and `access` are
    // kept consistent: declaring either as data-losing implies the other, so a
    // partial declaration cannot produce `destructive: true, access: 'write'`,
    // which `capabilityRequiredFor` would price at `write`.
    const merged: IntentPrivacy = { ...inferred, ...declared };

    if (merged.destructive || merged.access === 'delete') {
      merged.destructive = true;
      merged.access = 'delete';
    }

    return merged;
  }

  private inferPrivacy(name: string, operation: 'query' | 'mutation'): IntentPrivacy {
    if (operation === 'query') {
      return {
        access: 'read',
        sensitivity: 'personal',
        destructive: false,
        external: false,
      };
    }

    const lowerName = name.toLowerCase();
    const destructive = DESTRUCTIVE_MUTATION_PREFIXES.some((prefix) => lowerName.startsWith(prefix));

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
