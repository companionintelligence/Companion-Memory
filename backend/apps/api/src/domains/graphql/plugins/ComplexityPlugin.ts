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
        const complexity = getComplexity({
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
