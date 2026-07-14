import type { GraphQLSchemaHost } from '@nestjs/graphql';
import { buildSchema, type GraphQLSchema } from 'graphql';

import type { LoggerService } from '@ci/common/logging';

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
      expect(tool.privacy.external).toBe(false);
    }
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

  it('does not treat non-prefix substrings as destructive', () => {
    // "forget" is destructive-in-spirit but not in the prefix list; it stays a plain write so the
    // synthesis rule is conservative and predictable (prefix match only, not substring).
    expect(privacyOf('mutation_forgetMemory').destructive).toBe(false);
  });
});
