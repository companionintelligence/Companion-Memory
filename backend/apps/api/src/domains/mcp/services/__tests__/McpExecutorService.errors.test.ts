import { HttpException, HttpStatus } from '@nestjs/common';
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from 'graphql';
import { QueryFailedError } from 'typeorm';

import { McpExecutorService } from '../McpExecutorService';

/**
 * The GraphQL plane over MCP calls `execute` itself, so Apollo's `formatError`
 * never ran on what it returned: a resolver's database error reached the MCP
 * client as the driver's text while `/graphql` answered "Internal server
 * error". These resolvers throw what the real ones do.
 */
const query = new GraphQLObjectType({
  name: 'Query',
  fields: {
    refused: {
      type: GraphQLString,
      resolve: () => {
        throw new QueryFailedError(
          'UPDATE ci.events SET end_time = $1',
          [],
          Object.assign(
            new Error('new row for relation "events" violates check constraint "valid_time_range"'),
            {
              code: '23514',
            },
          ),
        );
      },
    },
    badInput: {
      type: GraphQLString,
      resolve: () => {
        throw new HttpException('`endTime` must not precede `startTime`', HttpStatus.BAD_REQUEST);
      },
    },
  },
});

function executor() {
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new McpExecutorService({ schema: new GraphQLSchema({ query }) } as never, logger as never);

  return { service, logger };
}

function tool(operationName: string) {
  return {
    name: `query_${operationName}`,
    operationName,
    operationType: 'query',
    graphqlArgs: [],
    returnType: GraphQLString,
  } as never;
}

describe('McpExecutorService errors', () => {
  it('masks a resolver database error the way /graphql does, and logs the original', async () => {
    const { service, logger } = executor();

    const result = (await service.executeTool(tool('refused'), {}, {})) as {
      errors: Array<{ message: string; extensions?: { code?: string } }>;
    };

    expect(result.errors[0].message).toBe('Internal server error');
    expect(result.errors[0].extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    expect(JSON.stringify(result)).not.toMatch(/valid_time_range|relation/);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('valid_time_range'));
  });

  it('passes an error a resolver raised on purpose through, as /graphql does', async () => {
    const { service } = executor();

    const result = (await service.executeTool(tool('badInput'), {}, {})) as {
      errors: Array<{ message: string; extensions?: { code?: string } }>;
    };

    expect(result.errors[0].message).toBe('`endTime` must not precede `startTime`');
    expect(result.errors[0].extensions?.code).toBe('BAD_USER_INPUT');
  });
});
