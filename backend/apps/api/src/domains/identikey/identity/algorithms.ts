import { IdentiKeyError } from '../errors';

/**
 * The algorithm registry (identikey-auth-challenge-v1 §3.1). Keys and signatures carry their algorithm
 * as a text tag, so a verifier never infers one from a length and a new algorithm is an addition to
 * these lists rather than a change to the wire format.
 *
 * Classical algorithms are the identity's PRIMARY key: its fingerprint is the identity. Post-quantum
 * algorithms are optional and always travel with a classical one ("PQ implies classical").
 */
export const CLASSICAL_ALGORITHMS = ['ed25519', 'p256'] as const;
export type ClassicalAlg = (typeof CLASSICAL_ALGORITHMS)[number];

/** FIPS 204 parameter sets, by security category (2, 3 and 5). */
export const PQ_ALGORITHMS = ['ml-dsa-44', 'ml-dsa-65', 'ml-dsa-87'] as const;
export type PqAlg = (typeof PQ_ALGORITHMS)[number];

/** A tag from the wire can be any length; it goes into a log line, so cut it and escape it. */
const describe = (tag: string): string => JSON.stringify(tag.slice(0, 32));

export function classicalAlgFromTag(tag: string): ClassicalAlg {
  const found = CLASSICAL_ALGORITHMS.find((alg) => alg === tag);
  if (found === undefined) {
    throw new IdentiKeyError('unknown-algorithm', `${describe(tag)} is not a classical algorithm`);
  }

  return found;
}

export function pqAlgFromTag(tag: string): PqAlg {
  const found = PQ_ALGORITHMS.find((alg) => alg === tag);
  if (found === undefined) {
    throw new IdentiKeyError('unknown-algorithm', `${describe(tag)} is not a post-quantum algorithm`);
  }

  return found;
}
