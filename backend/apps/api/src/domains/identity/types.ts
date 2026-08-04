/**
 * Object identity primitives — the foundation layer of
 * `docs/prd/unified-content-identity-lifecycle-embeds.md` (§4).
 *
 * This module is deliberately dependency-free (Node builtins only) so it can be
 * lifted into `backend/packages/object-identity` and vendored into
 * CI-Import-Tools unchanged once the cross-repo sync lands (design P3). Keep it
 * that way: no Nest, no TypeORM, no repo-local imports.
 */

/**
 * Bumped whenever a normalisation rule changes in a way that would produce a
 * different `valueNormalized` for the same input. Persisted per identifier row
 * so a recompute leg can find stale rows (`WHERE spec_version < $current`).
 */
export const IDENTITY_SPEC_VERSION = 1;

/**
 * Identity rungs, highest precedence first.
 *
 * `sha256` sits *below* `url` on purpose: a zero-byte attachment or a shared
 * stock JPEG is bytes-identical across unrelated objects, so collapsing on
 * bytes alone over-merges irreversibly. See {@link buildContentHashIdentity}.
 *
 * There is deliberately no random rung — every rung is derived, so replaying the
 * same input always yields the same key and ingest stays idempotent.
 */
export type IdentityKind = 'src' | 'url' | 'sha256' | 'txt' | 'nat';

/** Survivor precedence on merge. Index 0 wins. */
export const IDENTITY_KIND_PRECEDENCE: readonly IdentityKind[] = [
  'src',
  'url',
  'sha256',
  'txt',
  'nat',
] as const;

/**
 * Maximum length of `ci.object_identifiers.value_normalized`, enforced by a
 * CHECK in the schema. Every rung below is bounded well under it by
 * construction — a digest is 64 hex chars, and the one non-digest rung
 * (`sha256`) is a digest plus a uuid.
 */
export const MAX_VALUE_NORMALIZED_LENGTH = 200;

export interface Identity {
  kind: IdentityKind;
  /** Bounded, collision-resistant. Safe as a btree unique key. */
  valueNormalized: string;
  /** Human-readable pre-digest form. Never indexed; for debugging and review UI. */
  raw?: string;
  confidence: number;
  specVersion: number;
}

/**
 * One component of a natural key.
 *
 * `temporal` is *declared*, never inferred from the name — an earlier revision
 * of this design tested for the literal string `timestamp`, which let `day`,
 * `start_iso` and `visit_time_ms` through and collapsed a whole day of activity
 * into one row.
 */
export interface Dimension {
  name: string;
  value: string | number | null | undefined;
  temporal: boolean;
}

export interface SourceTriple {
  type?: string | null;
  system?: string | null;
  id?: string | null;
}

export interface IdentityInput {
  specVersion?: number;
  /** Provenance triple. Only mints an `src` rung when all three legs are present. */
  source?: SourceTriple;
  /** Raw URL; canonicalised before hashing so spellings collapse. */
  url?: string | null;
  /** Hex sha256 of the payload bytes. */
  contentSha256?: string | null;
  /**
   * Row that owns the bytes. Required alongside `contentSha256`: it scopes the
   * bytes identity so identical bytes become a *merge candidate* rather than an
   * automatic collapse.
   */
  owningRowId?: string | null;
  /** Free text used only when nothing better exists (e.g. a note with no url). */
  text?: string | null;
  /** Precomputed by `buildNaturalKey`. The universal fallback rung. */
  naturalKey?: string | null;
}

/** Result of {@link canonicalizeUrl}. */
export interface CanonicalUrl {
  /** Normalised, human-readable URL. */
  canonical: string;
  /** Registrable host after alias mapping, lowercased, `www.` stripped. */
  host: string;
  /** Extractor name when a provider rule matched, e.g. `youtube`. */
  provider?: string;
  /** Stable provider handle, e.g. `youtube:video:dQw4w9WgXcQ`. */
  providerRef?: string;
}
