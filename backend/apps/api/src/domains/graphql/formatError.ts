import { HttpException, HttpStatus } from '@nestjs/common';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';

import { ContextService } from '@ci/common/context';

/**
 * What an unclassified failure is reduced to before it leaves the process.
 *
 * `GlobalExceptionsFilter` rethrows on the `graphql` context type, and the
 * driver had no `formatError`, so whatever a resolver threw travelled verbatim
 * to the client: a TypeORM `QueryFailedError` carries the SQL it failed on
 * (column names, and any literal that was not parameterised), an Ollama fetch
 * failure carries the internal host and port. Stack traces were suppressed only
 * as a side effect of `NODE_ENV=production` in the image — nothing suppressed
 * the messages.
 */
const MASKED_MESSAGE = 'Internal server error';

const INTERNAL_SERVER_ERROR = 'INTERNAL_SERVER_ERROR';

/**
 * HTTP status → GraphQL error code for errors the application raised on
 * purpose. `@nestjs/apollo`'s own `autoTransformHttpErrors` wrapper runs just
 * before this function and already maps 400/401/403/422, but it flattens every
 * other status — 404 and 409 included — to `INTERNAL_SERVER_ERROR`, which is
 * exactly the bucket masked below. So the code is re-derived from the status
 * here rather than trusted from the formatted error we are handed.
 *
 * 400 maps to `BAD_USER_INPUT` rather than Nest's `BAD_REQUEST` so that the two
 * "the caller sent something wrong" statuses (400 and 422) read the same to a
 * client.
 */
const CODES_BY_STATUS: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'BAD_USER_INPUT',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'BAD_USER_INPUT',
  [HttpStatus.TOO_MANY_REQUESTS]: 'TOO_MANY_REQUESTS',
};

/**
 * graphql-js wraps whatever a resolver threw in a `GraphQLError` and keeps the
 * throwable on `originalError`; errors raised outside resolution (a validation
 * rule, `ComplexityPlugin`) arrive unwrapped. Both shapes have to be classified
 * on what the application actually threw, not on the wrapper.
 */
function unwrap(error: unknown): unknown {
  if (error instanceof GraphQLError && error.originalError) {
    return error.originalError;
  }

  return error;
}

/**
 * Short prefix of the request's trace id, so a masked error can still be tied
 * to the logged one. The full uuid already goes out on the `X-Trace-Id`
 * response header and into every log line for the request (see
 * `RequestContextMiddleware` and `LoggerService`), so eight hex characters are
 * enough to grep with. Returns null when no request context is in scope rather
 * than minting an id that correlates with nothing.
 */
function correlationId(): string | null {
  const traceId = ContextService.getTraceId();

  return traceId ? traceId.replace(/-/g, '').slice(0, 8) : null;
}

/**
 * Apollo `formatError`. Passes deliberate application errors through untouched
 * and replaces everything else with {@link MASKED_MESSAGE}.
 */
export function formatError(formattedError: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const extensions = { ...formattedError.extensions };

  // Apollo attaches this whenever NODE_ENV is not `production`, which is the
  // only reason it is not already on the wire. Nothing that reaches a client
  // should depend on the deployment's NODE_ENV.
  delete extensions.stacktrace;

  const originalError = unwrap(error);

  // Raised on purpose by a resolver or guard. The message is part of the
  // contract — clients render it — so it passes through verbatim.
  if (originalError instanceof HttpException) {
    return {
      ...formattedError,
      extensions: {
        ...extensions,
        code: CODES_BY_STATUS[originalError.getStatus()] ?? INTERNAL_SERVER_ERROR,
      },
    };
  }

  // A code that is not the catch-all was set deliberately — by application code
  // (`ComplexityPlugin` throws `BAD_REQUEST`) or by Apollo itself for a request
  // that never reached a resolver (`GRAPHQL_PARSE_FAILED`,
  // `GRAPHQL_VALIDATION_FAILED`, `BAD_USER_INPUT`). Those messages describe the
  // caller's own query, not our internals.
  if (typeof extensions.code === 'string' && extensions.code !== INTERNAL_SERVER_ERROR) {
    return { ...formattedError, extensions };
  }

  const id = correlationId();

  return {
    message: MASKED_MESSAGE,
    // `locations` and `path` describe the query the caller sent us, so they are
    // safe to keep and are what makes a masked error actionable at all.
    ...(formattedError.locations ? { locations: formattedError.locations } : {}),
    ...(formattedError.path ? { path: formattedError.path } : {}),
    extensions: {
      code: INTERNAL_SERVER_ERROR,
      ...(id ? { correlationId: id } : {}),
    },
  };
}
