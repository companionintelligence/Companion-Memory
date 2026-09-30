import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

import type { StagedPushStatus } from './pushState';

/**
 * A person, place or thing a parser saw while reading an export. Mirrors
 * migration 20260810164304_create_ci_import_schema.
 *
 * The doubled suffix is not a typo: the importer's own domain language calls
 * these graph nodes "entities", and every TypeORM class in this codebase is
 * suffixed `Entity`. `StagedEntity` alone would read as the base class of the
 * other staged rows, which it is not.
 *
 * Scoped to its run and deleted with it, like every other `staged_*` row. The
 * mapping from one of these to the durable `ci.entities` row it became lives in
 * `entity_mappings`.
 */
@Entity({ schema: 'ci_import', name: 'staged_entities' })
@Index('staged_entities_run_type_name_idx', ['runId', 'type', 'name'])
export class StagedEntityEntity {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'text', nullable: true })
  type!: string | null;

  @Column({ type: 'text', nullable: true })
  name!: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata!: Record<string, unknown>;

  /**
   * The parser that produced this entity — part of its server-side identity.
   *
   * `GraphIngestService` files an imported entity under
   * `linked_table = 'import:<sourceSystem>'`, so the source system is not
   * decoration: it decides which existing row a re-import resolves to. It cannot
   * be taken from the run, because one run spans several parsers — an Amazon
   * archive stages `audible`, `prime_video`, `kindle_reading` and `amazon_music`
   * together.
   *
   * Null for entities staged before the column existed; the push path reads that
   * as 'unknown' rather than refusing to resolve them.
   */
  @Column({ type: 'text', name: 'data_source', nullable: true })
  dataSource!: string | null;

  /**
   * The normalized handle this entity is known by: lower-cased email, or the
   * last ten digits of a phone number.
   *
   * Identity has to key on WHO someone is, because the display name drifts
   * across sources — "Alice", "Alice Smith" and the bare address are one person
   * and must not become three contacts. NULL for entities that have no handle at
   * all (threads, places), which is why the uniqueness constraint behind this is
   * partial: handle-less entities must not collapse into each other.
   */
  @Column({ type: 'text', name: 'identity_key', nullable: true })
  identityKey!: string | null;

  /**
   * The identity key the rule BEFORE shared handles gave this entity — its
   * smallest handle, shared or not, of those its parser read then — when that
   * differs from `identityKey`; NULL when they agree, and for rows staged
   * before the column existed.
   *
   * Rows already in `ci.entities` were minted under that key, and a moved key
   * would mint a second Person on the next import. The push uses this to move
   * the old row onto the new key in place — see `push/legacyKeys.ts` and
   * `staging/identity.ts legacyEntityIdentityKey`.
   */
  @Column({ type: 'text', name: 'legacy_identity_key', nullable: true })
  legacyIdentityKey!: string | null;

  /**
   * Dedup key for entities that have NO identity_key — a sha256 of
   * `entityKey(entity)`, unique per run. Handle-less entities cannot share the
   * identity index (they would all collapse on NULL), and holding their dedup
   * in a per-attempt Map meant a resumed parse re-inserted everything the dead
   * attempt had written. NULL for identity-keyed rows and for anything written
   * before the column existed.
   */
  @Column({ type: 'text', name: 'dedupe_key', nullable: true })
  dedupeKey!: string | null;

  /**
   * Set when an already-staged entity's metadata GREW after a later sighting
   * (the `accumulate[]` contract on the parsers' `Entity` type — an Uber Eats
   * dish costing $10.19 in January and $15.92 in March is two true facts, not a
   * correction).
   *
   * The push resumes from a high-water mark, so a row that changed after it was
   * already sent would never be revisited without this flag.
   */
  @Column({ type: 'boolean', name: 'graph_dirty', default: false })
  graphDirty!: boolean;

  @Column({ type: 'text', name: 'push_status', default: 'pending' })
  pushStatus!: StagedPushStatus;

  @Column({ type: 'text', name: 'push_error', nullable: true })
  pushError!: string | null;

  @Column({ type: 'timestamptz', name: 'pushed_at', nullable: true })
  pushedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}

export type StagedEntity = Readonly<StagedEntityEntity>;
