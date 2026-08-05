import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * A pair the user has declared distinct — the memory of a rejected merge.
 *
 * Entity-agnostic on purpose: no `entity_type`, nothing Person-specific. The
 * pair of ids IS the assertion, and Location/Object need the same thing the
 * moment they get duplicate detection.
 *
 * Always stored with `entityIdA < entityIdB` (enforced by a CHECK) so a pair is
 * one row in one direction — see {@link orderPair}.
 */
@Entity({ schema: 'ci', name: 'entity_merge_blocks' })
export class EntityMergeBlockEntity {
  @PrimaryColumn({ name: 'block_id', type: 'uuid' })
  id!: string;

  @Column({ name: 'owner_user_id', type: 'uuid' })
  ownerUserId!: string;

  @Column({ name: 'entity_id_a', type: 'uuid' })
  entityIdA!: string;

  @Column({ name: 'entity_id_b', type: 'uuid' })
  entityIdB!: string;

  /** `user_rejected` | `unmerged`, or a future automated source. */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * The canonical ordering for a pair. Callers hand ids in whatever order the UI
 * produced them; storage and lookup both go through this so (A,B) and (B,A) are
 * the same row.
 */
export function orderPair(one: string, two: string): [string, string] {
  return one < two ? [one, two] : [two, one];
}

/** Stable key for a pair, for set membership in memory. */
export function pairKey(one: string, two: string): string {
  const [a, b] = orderPair(one, two);

  return `${a}|${b}`;
}
