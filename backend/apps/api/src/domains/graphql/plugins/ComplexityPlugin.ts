import { ApolloServerPlugin, type BaseContext, type GraphQLRequestListener } from '@apollo/server';
import { Plugin } from '@nestjs/apollo';
import { HttpStatus } from '@nestjs/common';
import { GraphQLSchemaHost } from '@nestjs/graphql';
import { GraphQLError } from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

@Plugin()
export class ComplexityPlugin implements ApolloServerPlugin {
  constructor(
    private readonly gqlSchemaHost: GraphQLSchemaHost,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(ComplexityPlugin.name);
  }

  async requestDidStart(): Promise<GraphQLRequestListener<BaseContext>> {
    const { schema } = this.gqlSchemaHost;

    const logger = this.logger;

    return {
      async didResolveOperation({ request, document }) {
        let complexity: number;

        try {
          complexity = getComplexity({
            schema,
            operationName: request.operationName,
            query: document,
            variables: request.variables,
            estimators: [
              // Checks if a specific field has a custom complexity defined
              fieldExtensionsEstimator(),

              // Fallback to assigning a value of 1 to every field
              simpleEstimator({
                defaultComplexity: 1,
              }),
            ],
          });
        } catch (error) {
          throw asClientError(error);
        }

        if (complexity > config.graphql.maxQueryComplexity) {
          throw new GraphQLError(
            `Query is too complex: ${complexity}. Maximum allowed complexity: ${config.graphql.maxQueryComplexity}`,
            {
              extensions: {
                code: 'BAD_REQUEST',
                http: {
                  status: HttpStatus.BAD_REQUEST,
                },
              },
            },
          );
        }

        logger.log('GraphQL complexity logged', {
          complexity,
        });
      },
    };
  }
}

/**
 * The error `getComplexity` threw, as the client error it is.
 *
 * `getComplexity` coerces the request's variables itself, before Apollo's executor does, and throws
 * the first coercion error (`Variable "$id" of required type "ID!" was not provided.`) as a bare
 * `GraphQLError` with no `code`. Thrown from `didResolveOperation` without one, Apollo answered it
 * as HTTP 500 `INTERNAL_SERVER_ERROR`, which `formatError` then masked to "Internal server error":
 * a mistake in the client's request read as a server fault and hid what was wrong. Marked here the
 * way Apollo marks the same error when it finds it: `BAD_USER_INPUT`, HTTP 400, its own message.
 * Anything that is not a `GraphQLError` is a fault in the estimator and is rethrown unchanged.
 */
export function asClientError(error: unknown): unknown {
  if (!(error instanceof GraphQLError) || error.extensions?.code != null) {
    return error;
  }

  return new GraphQLError(error.message, {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    path: error.path,
    extensions: {
      ...error.extensions,
      code: 'BAD_USER_INPUT',
      http: {
        status: HttpStatus.BAD_REQUEST,
      },
    },
  });
}
