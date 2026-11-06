import type { Connection } from './Connection';

/**
 * What a resolver returns when its page comes from `keysetPaginate` and the
 * `COUNT(*)` behind `totalCount` ran only if the operation selected it. The
 * field stays non-null in the schema (`@Query(() => XConnection)` is what
 * declares it), so a response that asked for the count and did not get one
 * fails loudly rather than reporting 0.
 */
export type OptionalTotal<C extends Connection> = Omit<C, 'totalCount'> & { totalCount?: number };
