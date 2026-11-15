import { ApolloServer } from '@apollo/server';
import type { GraphQLSchemaHost } from '@nestjs/graphql';
import { buildSchema, GraphQLError } from 'graphql';

import type { LoggerService } from '@ci/common/logging';

import { formatError } from '../../formatError';
import { asClientError, ComplexityPlugin } from '../ComplexityPlugin';

const schema = buildSchema(`
  type Person { id: ID! }
  type Query { person(id: ID!): Person }
`);

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

/** A real Apollo server with the plugin and the API's own `formatError`, as `/graphql` has them. */
async function server(): Promise<ApolloServer> {
  const apollo = new ApolloServer({
    schema,
    rootValue: { person: ({ id }: { id: string }) => ({ id }) },
    plugins: [new ComplexityPlugin({ schema } as GraphQLSchemaHost, logger())],
    formatError,
  });

  await apollo.start();

  return apollo;
}

const QUERY = 'query ($id: ID!) { person(id: $id) { id } }';

describe('ComplexityPlugin, a request whose variables do not coerce', () => {
  let apollo: ApolloServer;

  beforeAll(async () => {
    apollo = await server();
  });

  afterAll(async () => {
    await apollo.stop();
  });

  async function run(variables: Record<string, unknown>) {
    const response = await apollo.executeOperation({ query: QUERY, variables });

    if (response.body.kind !== 'single') {
      throw new Error('expected a single result');
    }

    return { status: response.http.status, errors: response.body.singleResult.errors };
  }

  it('answers a missing required variable as a 400 BAD_USER_INPUT with its own message', async () => {
    const { status, errors } = await run({});

    expect(status).toBe(400);
    expect(errors).toHaveLength(1);
    expect(errors?.[0].message).toBe('Variable "$id" of required type "ID!" was not provided.');
    expect(errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
    expect(errors?.[0].extensions?.stacktrace).toBeUndefined();
  });

  it('answers a variable of the wrong shape the same way, not as a masked 500', async () => {
    const { status, errors } = await run({ id: { not: 'an id' } });

    expect(status).toBe(400);
    expect(errors?.[0].message).toMatch(/^Variable "\$id" got invalid value/);
    expect(errors?.[0].message).not.toBe('Internal server error');
    expect(errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('still runs a request whose variables are fine', async () => {
    const response = await apollo.executeOperation({ query: QUERY, variables: { id: 'p-1' } });

    expect(response.body.kind === 'single' && response.body.singleResult.data).toEqual({
      person: { id: 'p-1' },
    });
  });
});

describe('asClientError', () => {
  it('leaves an error that already has a code alone', () => {
    const coded = new GraphQLError('too complex', { extensions: { code: 'BAD_REQUEST' } });

    expect(asClientError(coded)).toBe(coded);
  });

  it('leaves an error that is not a GraphQLError alone (a fault in the estimator)', () => {
    const fault = new Error('Query complexity could not be calculated');

    expect(asClientError(fault)).toBe(fault);
  });
});
