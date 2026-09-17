import type { GraphQLSchemaHost } from '@nestjs/graphql';
import { buildSchema, type GraphQLObjectType, type GraphQLSchema } from 'graphql';

import type { LoggerService } from '@ci/common/logging';
import { GRAPHQL_PRIVACY_EXTENSION, type IntentPrivacy } from '@ci/domains/tools';

import { findUndeclaredMutations, GraphQLToolAdapter } from './GraphQLToolAdapter';

const SDL = /* GraphQL */ `
  type Memory {
    id: ID!
    content: String!
  }

  type Query {
    memory(id: ID!): Memory
    listMemories: [Memory!]!
  }

  type Mutation {
    createMemory(content: String!): Memory!
    updateMemory(id: ID!, content: String!): Memory!
    deleteMemory(id: ID!): Boolean!
    removeAllMemories: Boolean!
    forgetMemory(id: ID!): Boolean!
  }
`;

/**
 * Stamp every mutation field in `schema` with a declared privacy extension — `{}` (an explicit
 * "reviewed, no override needed", same as a bare `@GraphqlPrivacy({})`) unless `overrides` names
 * something more specific for it.
 *
 * `GraphQLToolAdapter` now refuses to boot if ANY mutation is undeclared (see
 * `assertAllMutationsDeclared`), so every fixture schema below has to represent a fully-audited
 * schema, the same as production after this change — a fixture with a genuinely bare mutation
 * would throw on `onModuleInit()` before a test ever got to assert anything.
 */
function declareAllMutations(
  schema: GraphQLSchema,
  overrides: Record<string, Partial<IntentPrivacy>> = {},
): GraphQLSchema {
  const fields = schema.getMutationType()?.getFields() ?? {};

  for (const [name, field] of Object.entries(fields)) {
    field.extensions = { ...field.extensions, [GRAPHQL_PRIVACY_EXTENSION]: overrides[name] ?? {} };
  }

  return schema;
}

function buildAdapter(schema: GraphQLSchema): GraphQLToolAdapter {
  const schemaHost = { schema } as unknown as GraphQLSchemaHost;
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;

  const adapter = new GraphQLToolAdapter(schemaHost, logger);
  adapter.onModuleInit();

  return adapter;
}

/**
 * Attach a declared privacy label to `updateMemory` the way `@GraphqlPrivacy` does at runtime, and
 * return the label the adapter ends up advertising. The other four fixture mutations are stamped
 * `{}` by {@link declareAllMutations} purely to satisfy the completeness guard — they carry no
 * override, so they merge down to whatever `inferPrivacy` alone would produce for them.
 *
 * `updateMemory` is chosen because the name heuristic infers a plain `write` for it — so anything
 * destructive coming back proves the DECLARATION won rather than the inference.
 */
function buildAdapterWithDeclaredPrivacy(declared: Partial<IntentPrivacy>): IntentPrivacy {
  const schema = declareAllMutations(buildSchema(SDL), { updateMemory: declared });

  const tool = buildAdapter(schema)
    .getTools()
    .find((t) => t.name === 'mutation_updateMemory');

  if (!tool) {
    throw new Error('mutation_updateMemory not wrapped');
  }

  return tool.privacy;
}

describe('GraphQLToolAdapter privacy label synthesis', () => {
  // Every mutation declared `{}` except where a test below needs a real override — see
  // `declareAllMutations`. None of the five fixture mutations overrides anything here, so each
  // one's synthesized privacy is exactly what `inferPrivacy` alone produces, unchanged from before
  // the completeness guard existed.
  const adapter = buildAdapter(declareAllMutations(buildSchema(SDL)));

  const privacyOf = (name: string) => {
    const tool = adapter.getTools().find((t) => t.name === name);
    if (!tool) {
      throw new Error(`tool not found: ${name}`);
    }

    return tool.privacy;
  };

  it('labels every auto-wrapped tool (no unlabelled tools advertised)', () => {
    for (const tool of adapter.getTools()) {
      expect(tool.privacy).toBeDefined();
    }
  });

  it('defaults external to false, but no longer asserts it of every field', () => {
    // This used to assert `external === false` for EVERY wrapped tool, which locked in a claim the
    // schema contradicts: `sendPeerAsk` and `runAsk` reach another Companion and `createPeerLink`
    // establishes federation with one. Blanket-false surfaced to MCP clients as
    // `openWorldHint: false` — advertising a federated send as local CRUD. Those fields now declare
    // `external: true` via `@GraphqlPrivacy`; the DEFAULT is still false, which is what this pins.
    expect(privacyOf('mutation_forgetMemory').external).toBe(false);
  });

  it('labels queries as read + non-destructive', () => {
    expect(privacyOf('query_memory')).toEqual({
      access: 'read',
      sensitivity: 'personal',
      destructive: false,
      external: false,
    });
    expect(privacyOf('query_listMemories').access).toBe('read');
    expect(privacyOf('query_listMemories').destructive).toBe(false);
  });

  it('labels non-destructive mutations as write', () => {
    expect(privacyOf('mutation_createMemory')).toEqual({
      access: 'write',
      sensitivity: 'personal',
      destructive: false,
      external: false,
    });
    expect(privacyOf('mutation_updateMemory').access).toBe('write');
    expect(privacyOf('mutation_updateMemory').destructive).toBe(false);
  });

  it('flags delete-style mutations as delete + destructive', () => {
    for (const name of ['mutation_deleteMemory', 'mutation_removeAllMemories']) {
      const privacy = privacyOf(name);
      expect(privacy.access).toBe('delete');
      expect(privacy.destructive).toBe(true);
    }
  });

  it('falls back to the name prefix for a field that declares nothing beyond `{}`', () => {
    // The fallback is unchanged and still prefix-only, not substring: `forgetMemory` is declared
    // `{}` (see `declareAllMutations`) — a reviewed "nothing to override" rather than a genuinely
    // undeclared field, since GraphQLToolAdapter now refuses to boot with any undeclared mutation
    // (see the guard tests below). An empty declaration merges down to the inferred value exactly,
    // so this still pins the same behaviour: `forgetMemory` stays a plain write.
    //
    // What changed is the reading of that fact. This test used to call the behaviour
    // "conservative", which is backwards for a safety label — the conservative direction is to
    // OVER-flag, and under-flagging is what let `returnEventToSlate` delete an event at `write`
    // while `deleteEvent` required `full`. The prefix is now the fallback for a field that
    // declares no override, rather than the whole rule, and a field whose true behaviour differs
    // declares it.
    expect(privacyOf('mutation_forgetMemory').destructive).toBe(false);
  });

  it('lets a declared label override the name heuristic', () => {
    // The bug class this whole mechanism exists for: a mutation that destroys data without a
    // destructive-looking name. Declared privacy must beat the inference.
    const declared = buildAdapterWithDeclaredPrivacy({ access: 'delete', destructive: true });

    expect(declared.destructive).toBe(true);
    expect(declared.access).toBe('delete');
  });

  it('keeps access and destructive consistent when only one is declared', () => {
    // A partial declaration must not produce `destructive: true` with `access: 'write'`, which
    // `capabilityRequiredFor` would price at `write` — re-opening the gap from the other side.
    const declared = buildAdapterWithDeclaredPrivacy({ destructive: true });

    expect(declared.access).toBe('delete');
  });
});

/**
 * The completeness guard: this is the part of the bug the name-inference tests above cannot cover
 * on their own — inference being CORRECT for a declared field says nothing about whether every
 * field ends up declared. A schema is allowed to have undeclared mutations, as long as the code
 * that would ship it never does; these tests are what makes that true.
 */
describe('GraphQLToolAdapter mutation-privacy completeness guard', () => {
  it('findUndeclaredMutations lists exactly the mutations with no @GraphqlPrivacy extension', () => {
    const schema = buildSchema(/* GraphQL */ `
      type Mutation {
        declaredOne: Boolean!
        undeclaredOne: Boolean!
        declaredTwo: Boolean!
        undeclaredTwo: Boolean!
      }
    `);

    const mutationType = schema.getMutationType() as GraphQLObjectType;
    const fields = mutationType.getFields();
    fields.declaredOne!.extensions = { [GRAPHQL_PRIVACY_EXTENSION]: { destructive: false } };
    // A `{}` declaration still counts as declared — the KEY being present is what matters, not
    // whether it overrides anything. See `declareAllMutations` above.
    fields.declaredTwo!.extensions = { [GRAPHQL_PRIVACY_EXTENSION]: {} };

    expect(findUndeclaredMutations(mutationType).sort()).toEqual(['undeclaredOne', 'undeclaredTwo']);
  });

  it('findUndeclaredMutations returns empty once every mutation is declared', () => {
    const schema = declareAllMutations(buildSchema(SDL));

    expect(findUndeclaredMutations(schema.getMutationType() as GraphQLObjectType)).toEqual([]);
  });

  it('refuses to boot when a mutation has no @GraphqlPrivacy declaration', () => {
    // The exact shape of the original bug: a real schema with one undeclared mutation among
    // several declared ones. `unscheduleTask`-style, not a schema of nothing but undeclared
    // fields — the guard has to catch ONE gap, not just a wholly-unaudited schema.
    const schema = declareAllMutations(buildSchema(SDL));
    const forgetMemory = schema.getMutationType()?.getFields().forgetMemory;
    // `extensions` is typed readonly, so undeclare by reassigning the whole object rather than
    // deleting one key — same effect (the field ends up with no declaration at all).
    if (forgetMemory) {
      forgetMemory.extensions = {};
    }

    expect(() => buildAdapter(schema)).toThrow(/forgetMemory/);
    expect(() => buildAdapter(schema)).toThrow(/GraphqlPrivacy/);
  });

  it('does not throw once every mutation carries a declaration, empty or not', () => {
    expect(() => buildAdapter(declareAllMutations(buildSchema(SDL)))).not.toThrow();
  });

  it('does not require queries to be declared — only mutations', () => {
    // Read-only queries were always inferred correctly and are out of scope for this guard; see
    // the class doc on `synthesizePrivacy`. An undeclared QUERY must not block boot.
    const schema = declareAllMutations(buildSchema(SDL));

    expect(
      schema.getQueryType()?.getFields().memory?.extensions?.[GRAPHQL_PRIVACY_EXTENSION],
    ).toBeUndefined();
    expect(() => buildAdapter(schema)).not.toThrow();
  });
});
