import { defineEvent } from '@ci/domains/events';

import type { IndexableEntity } from './types';

/**
 * Emitted once per real retrieval call, routed to the `telemetry` queue and
 * persisted to `ci.retrieval_query_log` by `RetrievalQueryLogListener`.
 *
 * Fire-and-forget by construction: the emitters `void` the send and swallow its
 * failure, so nothing on the retrieval hot path waits for — or fails because of
 * — telemetry.
 *
 * @see migration 20260826205619 for why the query TEXT is not part of this
 * payload and never can be.
 */
export const RetrievalQueryEvent = 'retrieval.query';

/** Which entry point served the retrieval. Persisted as `caller`. */
export type RetrievalCaller =
  | 'search'
  | 'search_count'
  | 'search_prompt'
  | 'search_messages'
  | 'search_anchored'
  | 'recall';

/** Payload of {@link RetrievalQueryEvent}. */
export type RetrievalQueryPayload = {
  userId: string;
  caller: RetrievalCaller;
  /**
   * The strategy actually taken, after `auto` resolved. Null only where the
   * caller has no modes to choose between.
   */
  modeTaken: string | null;
  /**
   * Whitespace token count of the query. THE ONLY thing this payload carries
   * about what was asked — see {@link queryTokenCount}.
   */
  queryTokenCount: number;
  includeTypes: IndexableEntity[] | null;
  /**
   * The exclusions the query actually ran with, including the ones
   * `SearchService.applyDefaultTypeExclusions` injects when the caller names
   * none. Recording the caller's request rather than the effective filter would
   * hide that nearly every default search is a filtered search.
   */
  excludeTypes: IndexableEntity[] | null;
  resultCount: number;
  /** Best score in the result set, or null where the path produces no score. */
  topScore: number | null;
  latencyMs: number;
};

/**
 * Reduce a query to the one number that may leave the retrieval path.
 *
 * Whitespace tokens, not lexemes: it is a size, not an analysis, and it must
 * not depend on anything that could be reversed toward the text. Empty and
 * whitespace-only queries count 0.
 */
export function queryTokenCount(query: string): number {
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return 0;
  }

  return trimmed.split(/\s+/).length;
}

defineEvent<RetrievalQueryPayload>(RetrievalQueryEvent);

declare module '@ci/domains/events/registry' {
  interface EventRegistry {
    [RetrievalQueryEvent]: RetrievalQueryPayload;
  }
}
