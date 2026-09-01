/**
 * Branded identity types — see docs/design/cross-pipeline-identity.md.
 *
 * Identity is a property of the datum; provenance is a property of the arrival.
 * The `*_source_identity_uniq` indexes key on `(user_id, source_system,
 * source_id)`, so any two pipelines that compute the same pair for the same
 * real-world datum converge on one row. That only holds if the pair is minted
 * in exactly one place: this module. The brands below make an ad-hoc
 * `source_system` / `source_id` a compile error — every constructor lives in
 * `domains/memory/identity/`, and nothing else can produce these types.
 */

declare const sourceSystemBrand: unique symbol;
declare const sourceIdBrand: unique symbol;

/**
 * A registry-canonical `source_system`. Either a federated kind (`email`,
 * `calendar`, `file` — where an interchange standard makes the id globally
 * unique) or a canonical platform name (`reddit`, `youtube`, …).
 */
export type SourceSystem = string & { readonly [sourceSystemBrand]: never };

/** A `source_id` in the registry-canonical format for its system. */
export type SourceId = string & { readonly [sourceIdBrand]: never };

/** The identity pair as the write paths consume it. */
export interface SourceIdentity {
  system: SourceSystem;
  id: SourceId;
}

/**
 * INTERNAL to domains/memory/identity — the only casts to the branded types.
 * Not re-exported from the module index; call a builder instead.
 */
export const asSourceSystem = (value: string): SourceSystem => value as SourceSystem;
export const asSourceId = (value: string): SourceId => value as SourceId;
