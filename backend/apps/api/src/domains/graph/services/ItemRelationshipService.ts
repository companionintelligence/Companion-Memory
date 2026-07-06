import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';

import { ItemRelationshipEntity } from '../entities/ItemRelationshipEntity';

/** One item↔item edge referenced by both endpoints' provenance triples. */
export interface ItemRelationshipInputDto {
  fromSourceType: string;
  fromSourceSystem: string;
  fromSourceId: string;
  toSourceType: string;
  toSourceSystem: string;
  toSourceId: string;
  relation: string;
  metadata?: Record<string, unknown> | null;
}

export interface BulkItemRelationshipResult {
  /** Rows THIS call inserted (new edges). */
  inserted: number;
  /** Rows dropped as duplicates — already present, or a duplicate within the batch. */
  skipped: number;
}

/**
 * Idempotent, set-based bulk ingest of item↔item edges (email→attachment,
 * photo→album) from the importer into ci.item_relationships.
 *
 * The whole array lands in ONE `INSERT ... ON CONFLICT DO NOTHING` over the
 * (user_id, from-triple, to-triple, relation) unique index — no per-row
 * find-or-insert round-trips. `RETURNING id` tells us exactly which rows this
 * call inserted; everything else (already-present rows, and intra-batch
 * duplicates collapsed client-side) counts as skipped. Re-sending the same
 * batch inserts nothing and reports it all as skipped.
 */
@Injectable()
export class ItemRelationshipService {
  constructor(
    @InjectRepository(ItemRelationshipEntity)
    private readonly itemRelationshipRepository: Repository<ItemRelationshipEntity>,
  ) {}

  /** Stable key for the dedup arbiter: the two triples + relation, per owner. */
  private static edgeKey(e: ItemRelationshipInputDto): string {
    return [
      e.fromSourceType,
      e.fromSourceSystem,
      e.fromSourceId,
      e.toSourceType,
      e.toSourceSystem,
      e.toSourceId,
      e.relation,
    ].join('||');
  }

  async createMany(
    context: UserServiceContext,
    input: ItemRelationshipInputDto[],
  ): Promise<BulkItemRelationshipResult> {
    if (input.length === 0) {
      return { inserted: 0, skipped: 0 };
    }

    // Collapse duplicate edges WITHIN the batch before the INSERT. Postgres'
    // ON CONFLICT DO NOTHING already tolerates them, but a batch that lists the
    // same edge twice would otherwise trip "ON CONFLICT DO UPDATE command cannot
    // affect row a second time" were we ever to switch to DO UPDATE, and it keeps
    // the VALUES list (and the RETURNING-derived inserted count) honest.
    const seen = new Set<string>();
    const unique: ItemRelationshipEntity[] = [];

    for (const e of input) {
      const key = ItemRelationshipService.edgeKey(e);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);

      unique.push(
        this.itemRelationshipRepository.create({
          id: uuidv7(),
          userId: context.userId,
          fromSourceType: e.fromSourceType,
          fromSourceSystem: e.fromSourceSystem,
          fromSourceId: e.fromSourceId,
          toSourceType: e.toSourceType,
          toSourceSystem: e.toSourceSystem,
          toSourceId: e.toSourceId,
          relation: e.relation,
          metadata: e.metadata ?? {},
        }),
      );
    }

    // One set-based INSERT. `onConflict(... DO NOTHING)` targets the unique
    // arbiter verbatim so re-sends dedup; RETURNING id yields ONLY the rows this
    // statement actually inserted (conflicting rows return nothing under DO
    // NOTHING), which is our inserted count.
    const result = await this.itemRelationshipRepository
      .createQueryBuilder()
      .insert()
      .into(this.itemRelationshipRepository.metadata.target)
      .values(unique)
      .onConflict(
        `(user_id, from_source_type, from_source_system, from_source_id,` +
          ` to_source_type, to_source_system, to_source_id, relation) DO NOTHING`,
      )
      .returning(['id'])
      .execute();

    const inserted = (result.raw as unknown[])?.length ?? 0;

    return {
      inserted,
      // Everything sent that did not result in an insert: already-present rows
      // (dedup on re-send) plus the intra-batch duplicates we collapsed above.
      skipped: input.length - inserted,
    };
  }
}
