import { CombinedGraphQLErrors, ServerError } from '@apollo/client/errors';

/** A failure carrying GraphQL errors, as Apollo Client 4 reports a response whose `errors` came back. */
export function graphQLFailure(errors: Array<{ message: string; extensions?: Record<string, unknown> }>) {
  return new CombinedGraphQLErrors({ data: null, errors });
}

/** A request the server turned down before running it: GraphQL answers with errors and no `data`. */
export function requestFailure(errors: Array<{ message: string; extensions?: Record<string, unknown> }>) {
  return new CombinedGraphQLErrors({ errors });
}

/** An HTTP answer that was not a GraphQL response, as Apollo Client 4 reports a non-200 status. */
export function httpFailure(status: number, bodyText = '') {
  return new ServerError(`Received status code ${status}`, {
    response: new Response(null, { status }),
    bodyText,
  });
}

/** A request that got no answer, passed through unwrapped as Apollo Client 4 does for a rejected fetch. */
export function transportFailure(message = 'Failed to fetch') {
  return new TypeError(message);
}
