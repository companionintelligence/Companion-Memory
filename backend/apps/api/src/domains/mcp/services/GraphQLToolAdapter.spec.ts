import type { GraphQLSchemaHost } from '@nestjs/graphql';
import { buildSchema, type GraphQLSchema } from 'graphql';

import type { LoggerService } from '@ci/common/logging';
import { GRAPHQL_PRIVACY_EXTENSION, type IntentPrivacy } from '@ci/domains/tools';

import { GraphQLToolAdapter } from './GraphQLToolAdapter';

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
 * return the label the adapter ends up advertising.
 *
 * `updateMemory` is chosen because the name heuristic infers a plain `write` for it — so anything
 * destructive coming back proves the DECLARATION won rather than the inference.
 */
function buildAdapterWithDeclaredPrivacy(declared: Partial<IntentPrivacy>): IntentPrivacy {
  const schema = buildSchema(SDL);
  const field = schema.getMutationType()?.getFields().updateMemory;

  if (!field) {
    throw new Error('updateMemory missing from the fixture schema');
  }

  field.extensions = { ...field.extensions, [GRAPHQL_PRIVACY_EXTENSION]: declared };

  const tool = buildAdapter(schema)
    .getTools()
    .find((t) => t.name === 'mutation_updateMemory');

  if (!tool) {
    throw new Error('mutation_updateMemory not wrapped');
  }

  return tool.privacy;
}

describe('GraphQLToolAdapter privacy label synthesis', () => {
  const adapter = buildAdapter(buildSchema(SDL));

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

  it('falls back to the name prefix for a field that declares nothing', () => {
    // The fallback is unchanged and still prefix-only, not substring: an UNDECLARED
    // `forgetMemory` stays a plain write.
    //
    // What changed is the reading of that fact. This test used to call the behaviour
    // "conservative", which is backwards for a safety label — the conservative direction is to
    // OVER-flag, and under-flagging is what let `returnEventToSlate` delete an event at `write`
    // while `deleteEvent` required `full`. The prefix is now the fallback for undeclared fields
    // rather than the whole rule, and a field whose true behaviour differs declares it.
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
