import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';

import { ContextService } from '@ci/common/context';

import { formatError } from '../formatError';

/**
 * The shape Apollo hands `formatError` for an error a resolver threw: the
 * message copied off the throwable, the catch-all code, and (outside
 * production) a stacktrace.
 */
function formattedFor(error: Error): GraphQLFormattedError {
  return {
    message: error.message,
    locations: [{ line: 2, column: 3 }],
    path: ['search'],
    extensions: {
      code: 'INTERNAL_SERVER_ERROR',
      stacktrace: [`${error.name}: ${error.message}`, '    at Resolver.search'],
    },
  };
}

/** How graphql-js wraps whatever a resolver threw. */
function wrapped(error: Error): GraphQLError {
  return new GraphQLError(error.message, { originalError: error, path: ['search'] });
}

describe('formatError', () => {
  describe('errors the application raised on purpose', () => {
    it('passes an HttpException message through and codes it from the status', () => {
      const exception = new UnauthorizedException('Authentication token is required');

      const result = formatError(formattedFor(exception), wrapped(exception));

      expect(result.message).toBe('Authentication token is required');
      expect(result.extensions?.code).toBe('UNAUTHENTICATED');
    });

    it.each([
      { name: '403', exception: new ForbiddenException('Not your memory'), code: 'FORBIDDEN' },
      // 404, 409 and 429 are the interesting ones: @nestjs/apollo's own
      // transform flattens every status it does not know to
      // INTERNAL_SERVER_ERROR, which is the bucket this formatter masks.
      { name: '404', exception: new NotFoundException('No such person'), code: 'NOT_FOUND' },
      {
        name: '400',
        exception: new HttpException('Bad filter', HttpStatus.BAD_REQUEST),
        code: 'BAD_USER_INPUT',
      },
      {
        name: '409',
        exception: new HttpException('Already linked', HttpStatus.CONFLICT),
        code: 'CONFLICT',
      },
      {
        name: '429',
        exception: new HttpException('Slow down', HttpStatus.TOO_MANY_REQUESTS),
        code: 'TOO_MANY_REQUESTS',
      },
    ])('codes a $name as $code and keeps its message', ({ exception, code }) => {
      const result = formatError(formattedFor(exception), wrapped(exception));

      expect(result.message).toBe(exception.message);
      expect(result.extensions?.code).toBe(code);
    });

    it('leaves a code set deliberately by application code alone', () => {
      // What ComplexityPlugin throws — it never reaches a resolver, so Apollo
      // hands us the GraphQLError itself rather than a wrapper.
      const error = new GraphQLError('Query is too complex: 900. Maximum allowed complexity: 150', {
        extensions: { code: 'BAD_REQUEST' },
      });

      const result = formatError({ message: error.message, extensions: { code: 'BAD_REQUEST' } }, error);

      expect(result.message).toBe('Query is too complex: 900. Maximum allowed complexity: 150');
      expect(result.extensions?.code).toBe('BAD_REQUEST');
    });

    it.each(['GRAPHQL_VALIDATION_FAILED', 'GRAPHQL_PARSE_FAILED', 'BAD_USER_INPUT'])(
      'leaves Apollo-owned %s errors alone',
      (code) => {
        const message = 'Cannot query field "nope" on type "Query".';
        const error = new GraphQLError(message, { extensions: { code } });

        const result = formatError({ message, extensions: { code } }, error);

        expect(result.message).toBe(message);
        expect(result.extensions?.code).toBe(code);
      },
    );
  });

  describe('everything else', () => {
    it('masks a TypeORM failure rather than leaking the SQL it embeds', () => {
      const error = new Error(
        'duplicate key value violates unique constraint "people_pkey" — ' +
          'INSERT INTO "ci"."people"("id", "name") VALUES ($1, $2)',
      );

      const result = formatError(formattedFor(error), wrapped(error));

      expect(result.message).toBe('Internal server error');
      expect(result.message).not.toContain('INSERT INTO');
      expect(result.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it('masks an error thrown as a bare string', () => {
      const message = 'ollama fetch failed: connect ECONNREFUSED 10.0.0.4:11434';

      const result = formatError({ message }, 'boom');

      expect(result.message).toBe('Internal server error');
      expect(result.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    });

    it("keeps the locations and path, which describe the caller's own query", () => {
      const error = new Error('internal detail');

      const result = formatError(formattedFor(error), wrapped(error));

      expect(result.locations).toEqual([{ line: 2, column: 3 }]);
      expect(result.path).toEqual(['search']);
    });

    it('carries a correlation id derived from the request trace id', () => {
      const error = new Error('internal detail');

      const result = ContextService.run({ traceId: '3f2a1b0c-dead-4bee-8888-000000000001' }, () =>
        formatError(formattedFor(error), wrapped(error)),
      );

      // The prefix of the same uuid that went out on X-Trace-Id and into the
      // log line, so the masked error is still findable.
      expect(result.extensions?.correlationId).toBe('3f2a1b0c');
    });

    it('omits the correlation id rather than inventing one when no request is in scope', () => {
      const error = new Error('internal detail');

      const result = formatError(formattedFor(error), wrapped(error));

      expect(result.extensions).not.toHaveProperty('correlationId');
    });
  });

  describe('stack traces', () => {
    it('strips the stacktrace from a masked error', () => {
      const error = new Error('internal detail');

      const result = formatError(formattedFor(error), wrapped(error));

      expect(result.extensions).not.toHaveProperty('stacktrace');
    });

    it('strips the stacktrace from an error it passes through', () => {
      const exception = new NotFoundException('No such person');

      const result = formatError(formattedFor(exception), wrapped(exception));

      expect(result.extensions).not.toHaveProperty('stacktrace');
    });
  });
});
