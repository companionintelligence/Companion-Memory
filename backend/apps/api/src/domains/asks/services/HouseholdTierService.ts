import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { type HouseholdTier, HouseholdTierEntity } from '../entities/HouseholdTierEntity';
import { TRUST_TIERS, type TrustTier } from '../types';

/**
 * The tier a local asker gets when the owner has said nothing.
 *
 * `household` — the widest ceiling on the ladder, and the only tier exempt from
 * the sensitive-class floor. THIS IS THE DEFAULT THIS FILE DOES NOT CHANGE.
 * Whether it should be is a product decision, written up in
 * `docs/asks-household-default.md`; landing the mechanism first is what makes
 * that decision answerable instead of academic.
 *
 * Exported so the one place it is decided is greppable, and so the test that
 * pins it (threat-model D6: "the household half of that exemption is pinned by
 * NO test") names it rather than a bare string.
 */
export const DEFAULT_HOUSEHOLD_TIER: TrustTier = 'household';

/**
 * Per-owner trust tiers for other LOCAL accounts.
 *
 * The missing half of `resolveTier`, which returned `household` for every local
 * asker unconditionally — so the person who shares the appliance was by
 * construction the most privileged asker, and could not be demoted. That is G6
 * and threat T1.
 *
 * ═══ OWNER-SCOPED, IN BOTH DIRECTIONS ═══
 *
 * Every read and write here is keyed on the CALLER as owner. Two people on the
 * same box may rate each other differently and neither gets to set the other's
 * view — which is not a nicety: in exactly the households this feature is least
 * safe in, the ability of one member to edit another's consent posture would be
 * the whole attack.
 */
@Injectable()
export class HouseholdTierService {
  constructor(
    @InjectRepository(HouseholdTierEntity)
    private readonly repository: Repository<HouseholdTierEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(HouseholdTierService.name);
  }

  /**
   * The tier this owner has assigned `memberUserId`, or the default.
   *
   * NEVER THROWS AND NEVER RETURNS NULL. It is called on the disclosure path,
   * where the alternative to a tier is not "no ceiling" but "no answer" — and a
   * lookup failure that widened the ceiling would be the worst possible
   * direction to fail in. An unreadable stored value falls back to the
   * STRICTEST tier rather than the default, matching `ceilingOf`'s rule that a
   * value which is present but unreadable is not the same as one that is
   * absent.
   */
  async tierFor(ownerUserId: string, memberUserId: string): Promise<TrustTier> {
    const row = await this.repository.findOne({ where: { ownerUserId, memberUserId } });

    if (row == null) {
      return DEFAULT_HOUSEHOLD_TIER;
    }

    if (!(TRUST_TIERS as readonly string[]).includes(row.trustTier)) {
      this.logger.warn(`household tier ${row.id} holds an unreadable tier; treating as stranger`);

      return 'stranger';
    }

    return row.trustTier;
  }

  /** Every verdict this owner has recorded, for the management surface. */
  async listForOwner(context: UserServiceContext): Promise<HouseholdTier[]> {
    const rows = await this.repository.find({
      where: { ownerUserId: context.userId },
      order: { updatedAt: 'DESC' },
    });

    return rows.map(HouseholdTierEntity.toEgressType);
  }

  /**
   * Set (or change) the tier this owner assigns another local account.
   *
   * An UPSERT rather than a supersede, unlike a grant. This is a current
   * setting, not an append-only consent record: moving someone back to
   * `household` is changing your mind, and there is nothing here a later audit
   * needs to reconstruct — what was actually disclosed is in `ci.ask_audit`,
   * which records outcomes rather than postures.
   */
  async setTier(
    context: UserServiceContext,
    memberUserId: string,
    trustTier: string,
  ): Promise<HouseholdTier> {
    if (memberUserId === context.userId) {
      // Their own asks never reach the consent gate, so this could only ever be
      // a value nothing reads.
      throw new BadRequestException('You cannot set a tier for yourself');
    }

    const canonical = trustTier.trim().toLowerCase();
    if (!(TRUST_TIERS as readonly string[]).includes(canonical)) {
      // REJECTED at the write boundary, not coerced. `tierFor` fails closed
      // when it READS something unreadable, which is right there — but silently
      // storing a tier that will later read as `stranger` hands the owner a
      // setting they did not choose and no explanation of why their housemate
      // stopped getting answers.
      throw new BadRequestException(`trustTier must be one of: ${TRUST_TIERS.join(', ')}`);
    }

    const existing = await this.repository.findOne({
      where: { ownerUserId: context.userId, memberUserId },
    });

    const row = this.repository.create({
      id: existing?.id ?? uuidv7(),
      ownerUserId: context.userId,
      memberUserId,
      trustTier: canonical as TrustTier,
      createdAt: existing?.createdAt,
    });

    const saved = await this.repository.save(row);
    this.logger.log(`household tier set to ${canonical}`);

    return HouseholdTierEntity.toEgressType(saved);
  }
}
