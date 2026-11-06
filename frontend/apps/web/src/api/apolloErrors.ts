/**
 * How the web app reads a failed Apollo operation.
 *
 * Apollo Client 3 wrapped every failure in an `ApolloError` with `networkError` and
 * `graphQLErrors` fields. Apollo Client 4 reports the failure itself: GraphQL errors come
 * back as a `CombinedGraphQLErrors` (the list is its `errors`), an HTTP status answered
 * without a GraphQL response comes back as a `ServerError` (the status is its
 * `statusCode`), and a request that got no answer at all, a rejected fetch say, comes
 * back unwrapped. Call sites ask these questions instead of reading the classes, so the
 * meaning they had on Apollo 3 stays in one place.
 */
import { CombinedGraphQLErrors, ServerError } from '@apollo/client/errors';
import type { GraphQLFormattedError } from 'graphql';

/** The GraphQL errors of a failed operation, or none when the server gave no GraphQL response. */
export function graphQLErrorsOf(error: unknown): readonly GraphQLFormattedError[] {
  return CombinedGraphQLErrors.is(error) ? error.errors : [];
}

/**
 * Whether a failed operation got no GraphQL response: a rejected fetch, an HTTP status
 * answered without one, or a link that threw.
 */
export function isNetworkFailure(error: unknown): boolean {
  return error != null && !CombinedGraphQLErrors.is(error);
}

/**
 * The HTTP status a failed operation was answered with. A non-GraphQL answer carries it on the
 * error. A GraphQL answer carries none, but one with no `data` at all is a request the server
 * turned down before running it, which GraphQL over HTTP answers with a 4xx; that reads as 400.
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (ServerError.is(error)) {
    return error.statusCode;
  }

  if (CombinedGraphQLErrors.is(error) && error.data === undefined) {
    return 400;
  }

  return undefined;
}

/**
 * The `errors` in the body of an HTTP answer that was not a GraphQL response, when that
 * body is JSON carrying them. Apollo 3 exposed these as `networkError.result.errors`.
 */
export function bodyGraphQLErrorsOf(error: unknown): unknown[] {
  if (!ServerError.is(error)) {
    return [];
  }

  try {
    const errors = (JSON.parse(error.bodyText) as { errors?: unknown } | null)?.errors;

    return Array.isArray(errors) ? errors : [];
  } catch {
    return [];
  }
}
