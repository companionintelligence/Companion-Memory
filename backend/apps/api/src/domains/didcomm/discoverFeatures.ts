import { DidcommError } from './errors';
import { createMessage, type DidcommMessage, threadIdOf } from './message';

/**
 * Discover Features 2.0 (https://didcomm.org/discover-features/2.0): ask another agent which
 * protocols, goal codes and headers it supports.
 *
 * A disclosure is a choice, not a fact: an empty answer means "I am not telling you", and the
 * privacy section of the protocol warns that wide wildcard queries are how agents get fingerprinted.
 * {@link answerQueries} therefore only ever returns entries the caller put in the list it is
 * willing to disclose, and the agent never answers a query the sender is not authenticated for.
 */

export const DISCOVER_FEATURES_PROTOCOL = 'https://didcomm.org/discover-features/2.0';
export const QUERIES_TYPE = `${DISCOVER_FEATURES_PROTOCOL}/queries`;
export const DISCLOSE_TYPE = `${DISCOVER_FEATURES_PROTOCOL}/disclose`;

export interface FeatureQuery {
  /** `protocol`, `goal-code` and `header` are defined; unknown types are ignored. */
  'feature-type': string;
  /** The identifier to match; `*` matches any run of characters. */
  match: string;
}

export interface FeatureDisclosure {
  'feature-type': string;
  id: string;
  roles?: string[];
}

const MAX_QUERIES = 32;
const MAX_MATCH_LENGTH = 512;

/** Glob match where `*` is the only metacharacter. */
export function matchesPattern(pattern: string, value: string): boolean {
  const escaped = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));

  return new RegExp(`^${escaped.join('.*')}$`).test(value);
}

export function buildQueries(
  queries: FeatureQuery[],
  input: { from?: string; to: string[] },
  now?: number,
): DidcommMessage {
  return createMessage(
    {
      type: QUERIES_TYPE,
      ...(input.from !== undefined ? { from: input.from } : {}),
      to: input.to,
      body: { queries },
    },
    now,
  );
}

function readQueries(message: DidcommMessage): FeatureQuery[] {
  const queries = message.body?.queries;

  if (!Array.isArray(queries) || queries.length > MAX_QUERIES) {
    throw new DidcommError(
      'malformed-message',
      `discover-features "queries" must be an array of at most ${MAX_QUERIES}`,
    );
  }

  return queries.flatMap((query: unknown) => {
    const candidate = query as Partial<FeatureQuery> | null;

    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      typeof candidate['feature-type'] !== 'string' ||
      typeof candidate.match !== 'string' ||
      candidate.match.length > MAX_MATCH_LENGTH
    ) {
      throw new DidcommError(
        'malformed-message',
        'each discover-features query needs "feature-type" and "match"',
      );
    }

    return [candidate as FeatureQuery];
  });
}

/** The entries of `supported` that at least one query of the same feature type matches, in `supported` order. */
export function answerQueries(message: DidcommMessage, supported: FeatureDisclosure[]): FeatureDisclosure[] {
  if (message.type !== QUERIES_TYPE) {
    throw new DidcommError('invalid-argument', 'not a discover-features queries message');
  }

  const queries = readQueries(message);

  return supported.filter((feature) =>
    queries.some(
      (query) => query['feature-type'] === feature['feature-type'] && matchesPattern(query.match, feature.id),
    ),
  );
}

export function buildDisclose(
  queries: DidcommMessage,
  disclosures: FeatureDisclosure[],
  input: { from?: string } = {},
  now?: number,
): DidcommMessage {
  if (queries.from === undefined) {
    throw new DidcommError('invalid-argument', 'cannot answer a query that names no sender');
  }

  return createMessage(
    {
      type: DISCLOSE_TYPE,
      ...(input.from !== undefined ? { from: input.from } : {}),
      to: [queries.from],
      thid: threadIdOf(queries),
      body: { disclosures },
    },
    now,
  );
}
