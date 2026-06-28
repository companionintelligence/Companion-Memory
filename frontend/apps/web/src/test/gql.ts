import type { MockedResponse } from '@apollo/client/testing';
import type { TypedDocumentNode } from '@graphql-typed-document-node/core';
import type { DocumentNode } from 'graphql';

/**
 * Build an Apollo `MockedResponse` for a query/mutation document. Thin wrapper
 * that keeps test call-sites declarative:
 *
 *   mockQuery(SEARCH_QUERY, { query: 'foo' }, { search: [...] })
 *
 * Pass `{ error }` instead of data to simulate a network/GraphQL error, and
 * `maxUsageCount` for documents fetched more than once (e.g. cache-and-network).
 */
export function mockQuery<TData, TVariables extends Record<string, unknown>>(
  document: TypedDocumentNode<TData, TVariables> | DocumentNode,
  variables: TVariables,
  result: TData | { error: Error },
  opts: { delay?: number; maxUsageCount?: number } = {},
): MockedResponse<TData, TVariables> {
  const request = { query: document as DocumentNode, variables };
  const { delay, maxUsageCount } = opts;

  if (result && typeof result === 'object' && 'error' in result) {
    return { request, error: result.error, delay, maxUsageCount } as MockedResponse<TData, TVariables>;
  }

  return {
    request,
    result: { data: result as TData },
    delay,
    maxUsageCount,
  } as MockedResponse<TData, TVariables>;
}

// Re-export the shared mock entities so test files have a single import surface.
export {
  MOCK_ANSWERS,
  MOCK_COMMUNICATIONS,
  MOCK_CONCEPTS,
  MOCK_CONTENT,
  MOCK_EVENTS,
  MOCK_FILES,
  MOCK_ITEMS,
  MOCK_PEOPLE,
  MOCK_PLACES,
  MOCK_THREADS,
} from '@/graphql/mocks';
