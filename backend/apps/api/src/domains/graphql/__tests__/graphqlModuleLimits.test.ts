import { GraphQLModule } from '../index';
import { GRAPHQL_LIMITS } from '../requestLimits';

/** The options object handed to `NestGraphQLModule.forRoot`, read back off the module's imports. */
function driverOptions(): Record<string, unknown> {
  const imports = (Reflect.getMetadata('imports', GraphQLModule) ?? []) as Array<{
    providers?: Array<{ provide?: unknown; useValue?: unknown }>;
  }>;

  for (const imported of imports) {
    for (const provider of imported?.providers ?? []) {
      const value = provider?.useValue as Record<string, unknown> | undefined;

      if (value && typeof value === 'object' && 'driver' in value) {
        return value;
      }
    }
  }

  throw new Error('GraphQL driver options not found');
}

describe('GraphQL driver options', () => {
  it('makes Apollo refuse a document past the token limit while parsing', () => {
    expect(driverOptions().parseOptions).toEqual({ maxTokens: GRAPHQL_LIMITS.maxTokens });
  });
});
