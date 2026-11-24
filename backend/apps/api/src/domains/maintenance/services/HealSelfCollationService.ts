import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { toServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  decideSelfCollation,
  isExactOwnerIdentifier,
  matchOwner,
  readSelfIdentity,
  type OwnerMatch,
  type SelfIdentity,
} from '@ci/domains/import';
import { EntityMergeBlockService, pairKey, PersonMergeService } from '@ci/domains/memory';
import { PersonalizationService } from '@ci/domains/personalization';

export interface HealSelfCollationOptions {
  /** Cap on stub Persons merged/reviewed in one run. */
  limit?: number;
  /** Report candidates without calling mergePeople. */
  dryRun?: boolean;
}

export interface HealSelfCollationResult {
  selfEntityId: string | null;
  trustMode: string;
  examined: number;
  merged: number;
  reviewed: number;
  skipped: number;
  errors: string[];
  mergedSourceIds: string[];
}

/**
 * Repeatable maintenance job: fold owner-representing Person stubs into the
 * self Person when Autonomy trust allows (`person_self_merge`), otherwise leave
 * them for People → Possible duplicates.
 */
@Injectable()
export class HealSelfCollationService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly personMergeService: PersonMergeService,
    private readonly mergeBlockService: EntityMergeBlockService,
    @Inject(PersonalizationService)
    private readonly personalization: Pick<PersonalizationService, 'getTrustMode'>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(HealSelfCollationService.name);
  }

  async heal(userId: string, options: HealSelfCollationOptions = {}): Promise<HealSelfCollationResult> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const dryRun = options.dryRun === true;
    const ctx = toServiceContext({ userId });
    const trustMode = await this.personalization.getTrustMode(userId);
    const identity = await readSelfIdentity(this.dataSource, userId);
    const selfEntityId = await this.resolveSelfEntityId(userId);

    const result: HealSelfCollationResult = {
      selfEntityId,
      trustMode,
      examined: 0,
      merged: 0,
      reviewed: 0,
      skipped: 0,
      errors: [],
      mergedSourceIds: [],
    };

    if (selfEntityId == null) {
      this.logger.warn('heal_self_collation: no self entity', { userId });

      return result;
    }

    const candidates = await this.findOwnerStubCandidates(userId, selfEntityId, identity, limit);
    result.examined = candidates.length;

    if (candidates.length === 0) {
      return result;
    }

    const blocked = await this.mergeBlockService.blockedPairsAmong(ctx, [
      selfEntityId,
      ...candidates.map((c) => c.entityId),
    ]);

    for (const candidate of candidates) {
      try {
        const { match } = candidate;
        const decision = decideSelfCollation(trustMode, match);

        const blockedPair = blocked.has(pairKey(selfEntityId, candidate.entityId));
        if (blockedPair && !(match.kind === 'email' && isExactOwnerIdentifier(match))) {
          result.skipped += 1;
          continue;
        }

        if (decision === 'auto') {
          if (!dryRun) {
            await this.personMergeService.mergePeople(ctx, [candidate.entityId], selfEntityId);
          }

          result.merged += 1;
          result.mergedSourceIds.push(candidate.entityId);
        } else if (decision === 'review') {
          result.reviewed += 1;
        } else {
          result.skipped += 1;
        }
      } catch (err) {
        result.errors.push(`${candidate.entityId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.logger.log('heal_self_collation finished', {
      userId,
      trustMode,
      examined: result.examined,
      merged: result.merged,
      reviewed: result.reviewed,
      skipped: result.skipped,
      dryRun,
    });

    return result;
  }

  private async resolveSelfEntityId(userId: string): Promise<string | null> {
    const rows: Array<{ entity_id: string | null }> = await this.dataSource.query(
      `SELECT entity_id FROM ci.users WHERE id = $1::uuid`,
      [userId],
    );

    return rows[0]?.entity_id ?? null;
  }

  private async findOwnerStubCandidates(
    userId: string,
    selfEntityId: string,
    identity: SelfIdentity,
    limit: number,
  ): Promise<Array<{ entityId: string; match: OwnerMatch }>> {
    const rows: Array<{ entity_id: string; name: string | null; properties: Record<string, unknown> }> =
      await this.dataSource.query(
        `SELECT entity_id, name, properties
           FROM ci.entities
          WHERE owner_user_id = $1::uuid
            AND entity_type = 'Person'
            AND entity_id <> $2::uuid
            AND is_active IS DISTINCT FROM FALSE
            AND merged_into_entity_id IS NULL
            AND (is_self IS DISTINCT FROM TRUE)
            AND (properties->>'is_self' IS DISTINCT FROM 'true')
          ORDER BY created_at ASC
          LIMIT $3`,
        [userId, selfEntityId, Math.max(limit * 20, 500)],
      );

    const out: Array<{ entityId: string; match: OwnerMatch }> = [];

    for (const row of rows) {
      const props = row.properties ?? {};
      const phones = Array.isArray(props.phones)
        ? props.phones.filter((p): p is string => typeof p === 'string')
        : [];
      const emails = Array.isArray(props.emails)
        ? props.emails.filter((e): e is string => typeof e === 'string')
        : typeof props.email === 'string'
          ? [props.email]
          : [];

      const candidates = [...emails, ...phones, ...(typeof row.name === 'string' ? [row.name] : [])];

      let best: OwnerMatch | null = null;
      for (const raw of candidates) {
        // Against the OWNER's phones. This used to pass the candidate's own
        // `phones`, so every Person holding a number matched itself as the
        // owner at phone confidence, and hands_off merged it into self.
        const match = matchOwner(identity, raw);
        if (match == null) {
          continue;
        }

        if (best == null || match.confidence > best.confidence) {
          best = match;
        }
      }

      // No name fallback through `makeIsSelf` here. `row.name` was already
      // tried above, and the one case where the raw predicate says yes and
      // `matchOwner` says no is a name that is only an address
      // ("liam.broza@elsewhere.example"), which `matchOwner` refuses on purpose.
      if (best != null) {
        out.push({ entityId: row.entity_id, match: best });
      }

      if (out.length >= limit) {
        break;
      }
    }

    return out;
  }
}
