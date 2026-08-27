import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import type { TrustTier } from '../types';

/**
 * `ci.household_tiers` — one owner's trust tier for another LOCAL account.
 *
 * ═══ THE ROW THAT DID NOT EXIST ═══
 *
 * `resolveTier` returned `household` for every local asker, unconditionally,
 * and `TIER_CEILINGS.household` is `{'*': 'full'}` — the widest ceiling AND the
 * only tier exempt from the sensitive-class floor. A housemate could receive
 * health, financial, location and credential disclosures at `full` with no
 * human in the loop, and there was nothing anywhere that could say otherwise.
 *
 * ABSENT MEANS `household`. Every box that exists behaves exactly as it did;
 * this table only records a decision an owner has actively made. Whether the
 * default is right is a product question, written up in
 * `docs/asks-household-default.md` — the mechanism landing first is what makes
 * that question answerable rather than academic.
 *
 * Unlike a grant, this is a CURRENT SETTING and not an append-only consent
 * record: an owner moving someone back to `household` is changing their mind,
 * not writing a second grant. What was actually disclosed lives in
 * `ci.ask_audit`, which records outcomes rather than postures.
 */
@Entity({ schema: 'ci', name: 'household_tiers' })
export class HouseholdTierEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id' })
  id!: string;

  /** Whose memory is disclosed FROM. */
  @Column({ type: 'uuid', name: 'owner_user_id' })
  ownerUserId!: string;

  /** The other local account this verdict is about. */
  @Column({ type: 'uuid', name: 'member_user_id' })
  memberUserId!: string;

  /**
   * The tier. `household` IS legal here, unlike on a peer link — it is the
   * default this table exists to let an owner move away from, and restoring it
   * must not require deleting the row.
   */
  @Column({ type: 'text', name: 'trust_tier' })
  trustTier!: TrustTier;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  static toEgressType(entity: HouseholdTierEntity): HouseholdTier {
    return {
      id: entity.id,
      ownerUserId: entity.ownerUserId,
      memberUserId: entity.memberUserId,
      trustTier: entity.trustTier,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    };
  }
}

export type HouseholdTier = Readonly<HouseholdTierEntity>;
