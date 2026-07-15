import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IndexSkipEntity } from '../entities/IndexSkipEntity';
import { ClearIndexSkipDto, RecordIndexSkipDto } from '../types';

/**
 * Persistent skip markers for the search index. A listener that examines a row
 * and intentionally does NOT embed it (low-value content) records a marker here
 * so `SearchIndexBackfillService.missingIds()` stops re-finding — and
 * re-enqueuing — that row on every sweep. Without the marker the backfill never
 * converges: skipped rows have no `ci_search.embeddings` row, so the LEFT JOIN
 * re-selects them forever and the resulting no-op jobs starve other types.
 */
@Injectable()
export class IndexSkipService {
  constructor(
    @InjectRepository(IndexSkipEntity)
    private readonly skipRepo: Repository<IndexSkipEntity>,
  ) {}

  /**
   * Upsert a skip marker (INSERT ... ON CONFLICT DO NOTHING — the first
   * recorded reason wins; re-examinations of the same row are no-ops).
   */
  async recordSkip(data: RecordIndexSkipDto): Promise<void> {
    await this.skipRepo
      .createQueryBuilder()
      .insert()
      .into(IndexSkipEntity)
      .values({
        entityType: data.entityType,
        entityId: data.entityId,
        reason: data.reason,
      })
      .orIgnore()
      .execute();
  }

  /**
   * Delete any stale skip marker for the pair — called after a successful embed
   * upsert so an updated row that BECAME embeddable stops being marked skipped.
   */
  async clearSkip(data: ClearIndexSkipDto): Promise<boolean> {
    const result = await this.skipRepo.delete({
      entityType: data.entityType,
      entityId: data.entityId,
    });

    return result.affected ? result.affected > 0 : false;
  }
}
