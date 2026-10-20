import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  browserActivityWeightedTexts,
  buildVectorUpsertStatement,
  communicationWeightedTexts,
  contentWeightedTexts,
  eventWeightedTexts,
  fileWeightedTexts,
  itemWeightedTexts,
  personWeightedTexts,
  type WeightedText,
} from '@ci/domains/search-ingress';

import { PIPELINE_QUEUES, STAGE_IDS } from '../../constants';
import type { Stage, StageResult, StageSource } from '../../types';
import { stageVersion } from '../../versions';

import { INDEX_EMBED_SOURCE } from './EmbedStage';
import {
  INDEX_EMBED_BROWSER_ACTIVITY_SOURCE,
  INDEX_EMBED_COMMUNICATION_SOURCE,
  INDEX_EMBED_EVENT_SOURCE,
  INDEX_EMBED_FILE_SOURCE,
  INDEX_EMBED_ITEM_SOURCE,
  INDEX_EMBED_PERSON_SOURCE,
} from './entityEmbedStages';
import {
  loadBrowserActivityRows,
  loadCommunicationRows,
  loadContentRows,
  loadEventRows,
  loadFileRows,
  loadItemRows,
  loadPersonRows,
} from './entityRows';

/** One candidate row, reduced to its identity and its weighted keyword texts. */
export interface VectorTextRow {
  id: string;
  texts: WeightedText[];
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The keyword-search (tsvector) stages — `index.vector*`, the sibling family
 * `index.embed`'s docs promised.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The dense embedding answers "similar meaning"; the weighted tsvector in
 * `ci_search.vectors` answers plain keyword search. The live listeners have
 * always written both; the pipeline previously wrote only the embedding, which
 * meant a row indexed by the pipeline was invisible to keyword search. These
 * stages close that gap with the same ledger properties: recorded outcomes,
 * versioned re-runs (bump when a type's weighted-text recipe changes), and
 * per-row failure reasons.
 *
 * A separate stage per id rather than tsvector work smuggled into the embed
 * stages, so a version bump can address the two independently: re-weighting
 * titles must not re-bill hours of GPU, and a model switch must not re-write
 * unchanged tsvectors.
 *
 * Local cost — the tsvector is computed by Postgres itself — so slices ride the
 * `pipeline-index` queue, not the Ollama-reserving embed queue. The upsert is
 * one statement per row (the weighted `setweight` expression is built per
 * row), which against local Postgres is milliseconds a slice; the round-trip
 * economics that force the embed stage to batch do not apply.
 */
export abstract class VectorStageBase implements Stage {
  abstract readonly id: string;

  abstract readonly version: number;

  abstract readonly entityTypes: readonly string[];

  abstract readonly source: StageSource;

  readonly queue = PIPELINE_QUEUES.INDEX;

  constructor(
    protected readonly dataSource: DataSource,
    protected readonly logger: LoggerService,
  ) {}

  protected get entityType(): string {
    return this.entityTypes[0];
  }

  /** The slice's rows reduced to `(id, weighted texts)` — same projection the embed sibling uses. */
  protected abstract loadTexts(userId: string, ids: string[]): Promise<VectorTextRow[]>;

  async run(ctx: UserServiceContext, ids: string[]): Promise<Map<string, StageResult>> {
    const results = new Map<string, StageResult>();

    if (ids.length === 0) {
      return results;
    }

    const rows = await this.loadTexts(ctx.userId, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));

    for (const id of ids) {
      if (!byId.has(id)) {
        results.set(id, { outcome: 'skipped', reason: 'source_row_missing' });
      }
    }

    for (const row of rows) {
      if (row.texts.length === 0) {
        results.set(row.id, { outcome: 'skipped', reason: 'empty' });

        continue;
      }

      try {
        await this.writeVector(ctx.userId, row);
        results.set(row.id, { outcome: 'done' });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        results.set(row.id, { outcome: 'failed', reason: 'vector_write_failed', detail: { message } });
        this.logger.error(
          `tsvector upsert failed for ${this.entityType} ${row.id}`,
          err instanceof Error ? err : new Error(message),
        );
      }
    }

    return results;
  }

  /**
   * The SAME statement as `SearchIngress.VectorService.upsert`, from the same
   * builder: the tsvector, and the device document beside it. Sharing the
   * builder is what keeps the two paths' index rows identical for identical
   * texts; the RETURNING a listener reads is simply ignored here.
   */
  private async writeVector(userId: string, row: VectorTextRow): Promise<void> {
    const { sql, params } = buildVectorUpsertStatement(row.texts, {
      id: uuidv7(),
      entityType: this.entityType,
      entityId: row.id,
      userId,
    });

    await this.dataSource.query(sql, params);
  }
}

@Injectable()
export class ContentVectorStage extends VectorStageBase {
  readonly id = STAGE_IDS.INDEX_VECTOR;

  readonly version = stageVersion(STAGE_IDS.INDEX_VECTOR);

  readonly entityTypes = ['content'] as const;

  readonly source = INDEX_EMBED_SOURCE;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    super(dataSource, logger);
    this.logger.setContext(ContentVectorStage.name);
  }

  protected async loadTexts(userId: string, ids: string[]): Promise<VectorTextRow[]> {
    const rows = await loadContentRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, texts: contentWeightedTexts(row) }));
  }
}

@Injectable()
export class CommunicationVectorStage extends VectorStageBase {
  readonly id = STAGE_IDS.INDEX_VECTOR_COMMUNICATION;

  readonly version = stageVersion(STAGE_IDS.INDEX_VECTOR_COMMUNICATION);

  readonly entityTypes = ['communication'] as const;

  readonly source = INDEX_EMBED_COMMUNICATION_SOURCE;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    super(dataSource, logger);
    this.logger.setContext(CommunicationVectorStage.name);
  }

  protected async loadTexts(userId: string, ids: string[]): Promise<VectorTextRow[]> {
    const rows = await loadCommunicationRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, texts: communicationWeightedTexts(row) }));
  }
}

@Injectable()
export class EventVectorStage extends VectorStageBase {
  readonly id = STAGE_IDS.INDEX_VECTOR_EVENT;

  readonly version = stageVersion(STAGE_IDS.INDEX_VECTOR_EVENT);

  readonly entityTypes = ['event'] as const;

  readonly source = INDEX_EMBED_EVENT_SOURCE;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    super(dataSource, logger);
    this.logger.setContext(EventVectorStage.name);
  }

  protected async loadTexts(userId: string, ids: string[]): Promise<VectorTextRow[]> {
    const rows = await loadEventRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, texts: eventWeightedTexts(row) }));
  }
}

@Injectable()
export class ItemVectorStage extends VectorStageBase {
  readonly id = STAGE_IDS.INDEX_VECTOR_ITEM;

  readonly version = stageVersion(STAGE_IDS.INDEX_VECTOR_ITEM);

  readonly entityTypes = ['item'] as const;

  readonly source = INDEX_EMBED_ITEM_SOURCE;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    super(dataSource, logger);
    this.logger.setContext(ItemVectorStage.name);
  }

  protected async loadTexts(userId: string, ids: string[]): Promise<VectorTextRow[]> {
    const rows = await loadItemRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, texts: itemWeightedTexts(row) }));
  }
}

@Injectable()
export class PersonVectorStage extends VectorStageBase {
  readonly id = STAGE_IDS.INDEX_VECTOR_PERSON;

  readonly version = stageVersion(STAGE_IDS.INDEX_VECTOR_PERSON);

  readonly entityTypes = ['person'] as const;

  readonly source = INDEX_EMBED_PERSON_SOURCE;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    super(dataSource, logger);
    this.logger.setContext(PersonVectorStage.name);
  }

  protected async loadTexts(userId: string, ids: string[]): Promise<VectorTextRow[]> {
    const rows = await loadPersonRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, texts: personWeightedTexts(row) }));
  }
}

@Injectable()
export class FileVectorStage extends VectorStageBase {
  readonly id = STAGE_IDS.INDEX_VECTOR_FILE;

  readonly version = stageVersion(STAGE_IDS.INDEX_VECTOR_FILE);

  readonly entityTypes = ['file'] as const;

  readonly source = INDEX_EMBED_FILE_SOURCE;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    super(dataSource, logger);
    this.logger.setContext(FileVectorStage.name);
  }

  protected async loadTexts(userId: string, ids: string[]): Promise<VectorTextRow[]> {
    const rows = await loadFileRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, texts: fileWeightedTexts(row) }));
  }
}

@Injectable()
export class BrowserActivityVectorStage extends VectorStageBase {
  readonly id = STAGE_IDS.INDEX_VECTOR_BROWSER_ACTIVITY;

  readonly version = stageVersion(STAGE_IDS.INDEX_VECTOR_BROWSER_ACTIVITY);

  readonly entityTypes = ['browser-activity'] as const;

  readonly source = INDEX_EMBED_BROWSER_ACTIVITY_SOURCE;

  constructor(@InjectDataSource() dataSource: DataSource, logger: LoggerService) {
    super(dataSource, logger);
    this.logger.setContext(BrowserActivityVectorStage.name);
  }

  protected async loadTexts(userId: string, ids: string[]): Promise<VectorTextRow[]> {
    const rows = await loadBrowserActivityRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, texts: browserActivityWeightedTexts(row) }));
  }
}
