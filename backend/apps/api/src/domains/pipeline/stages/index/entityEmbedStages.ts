import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EmbeddingGenerationService } from '@ci/common/embeddings';
import { LoggerService } from '@ci/common/logging';
import {
  browserActivitySearchDocument,
  communicationSearchDocument,
  eventSearchDocument,
  fileSearchDocument,
  itemSearchDocument,
  personSearchDocument,
} from '@ci/domains/search-ingress';

import { STAGE_IDS } from '../../constants';
import type { StageSource } from '../../types';

import { DenseEmbedStageBase, type EmbedDocumentRow } from './DenseEmbedStageBase';
import {
  loadBrowserActivityRows,
  loadCommunicationRows,
  loadEventRows,
  loadFileRows,
  loadItemRows,
  loadPersonRows,
} from './entityRows';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The per-entity-type dense-embed stages: everything the old search-index
 * queue embedded, on the ledger.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `index.embed` (content) proved the shape; these six extend it to the rest of
 * `SearchIndexBackfillService.BACKFILLABLE_ENTITIES`, which is what lets the
 * post-import kick — and eventually all bulk indexing — run through the
 * pipeline's traceable, model-versioned path instead of the old
 * embedding-exists ratchet.
 *
 * One class per type because a `Stage` declares exactly one `source` (the
 * argument lives at the top of `stages/enrich/PersonLinkStage.ts`); one FAMILY
 * because everything except the row projection is shared —
 * {@link DenseEmbedStageBase} owns the mechanics, `entityRows.ts` owns the
 * projections, and the type's `searchTexts` builder (shared with the live
 * listener) owns what text represents a row.
 *
 * `skipHeuristics` mirrors which listeners honour `embedSkipReason`:
 * communications, events and browser activity carry message-like text where the
 * too-short/trivial heuristics are signal; items, people and files legitimately
 * embed a bare short name, so only a truly empty document skips.
 * `honorsEmbedAllowlist` likewise mirrors which listeners consult
 * `shouldEmbedType`.
 */

export const INDEX_EMBED_COMMUNICATION_SOURCE: StageSource = {
  schema: 'ci',
  table: 'communications',
  idColumn: 'id',
  userColumn: 'user_id',
};

@Injectable()
export class CommunicationEmbedStage extends DenseEmbedStageBase {
  readonly id = STAGE_IDS.INDEX_EMBED_COMMUNICATION;

  readonly entityTypes = ['communication'] as const;

  readonly source = INDEX_EMBED_COMMUNICATION_SOURCE;

  protected readonly skipHeuristics = true;

  protected readonly honorsEmbedAllowlist = true;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    embeddingGenerationService: EmbeddingGenerationService,
    logger: LoggerService,
  ) {
    super(dataSource, embeddingGenerationService, logger);
    this.logger.setContext(CommunicationEmbedStage.name);
  }

  protected async loadDocuments(userId: string, ids: string[]): Promise<EmbedDocumentRow[]> {
    const rows = await loadCommunicationRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, document: communicationSearchDocument(row) }));
  }
}

export const INDEX_EMBED_EVENT_SOURCE: StageSource = {
  schema: 'ci',
  table: 'events',
  idColumn: 'event_id',
  userColumn: 'user_id',
  // `planned_block` is planning's own row (docs/architecture/planning-roadmap.md,
  // ci.events guardrail #2: "index the task, not the block"). The task carries
  // the words; the block only carries a time — and an autoplan run moving forty
  // blocks would otherwise be forty embedding calls at plan-loop frequency.
  // EventSearchIndexListener already refused these on the event-driven path;
  // this ledger path had no such guard and was embedding them anyway.
  predicate: "s.is_deleted IS NOT TRUE AND s.event_type <> 'planned_block'",
};

@Injectable()
export class EventEmbedStage extends DenseEmbedStageBase {
  readonly id = STAGE_IDS.INDEX_EMBED_EVENT;

  readonly entityTypes = ['event'] as const;

  readonly source = INDEX_EMBED_EVENT_SOURCE;

  protected readonly skipHeuristics = true;

  protected readonly honorsEmbedAllowlist = true;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    embeddingGenerationService: EmbeddingGenerationService,
    logger: LoggerService,
  ) {
    super(dataSource, embeddingGenerationService, logger);
    this.logger.setContext(EventEmbedStage.name);
  }

  protected async loadDocuments(userId: string, ids: string[]): Promise<EmbedDocumentRow[]> {
    const rows = await loadEventRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, document: eventSearchDocument(row) }));
  }
}

export const INDEX_EMBED_ITEM_SOURCE: StageSource = {
  schema: 'ci',
  table: 'objects',
  idColumn: 'object_id',
  userColumn: 'user_id',
};

@Injectable()
export class ItemEmbedStage extends DenseEmbedStageBase {
  readonly id = STAGE_IDS.INDEX_EMBED_ITEM;

  readonly entityTypes = ['item'] as const;

  readonly source = INDEX_EMBED_ITEM_SOURCE;

  protected readonly skipHeuristics = false;

  protected readonly honorsEmbedAllowlist = false;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    embeddingGenerationService: EmbeddingGenerationService,
    logger: LoggerService,
  ) {
    super(dataSource, embeddingGenerationService, logger);
    this.logger.setContext(ItemEmbedStage.name);
  }

  protected async loadDocuments(userId: string, ids: string[]): Promise<EmbedDocumentRow[]> {
    const rows = await loadItemRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, document: itemSearchDocument(row) }));
  }
}

/**
 * Person rows live in the shared `ci.entities` table behind the discriminator;
 * merge tombstones (rows folded into a canonical person) must never re-index —
 * a merge deletes the tombstone's embedding deliberately.
 */
export const INDEX_EMBED_PERSON_SOURCE: StageSource = {
  schema: 'ci',
  table: 'entities',
  idColumn: 'entity_id',
  userColumn: 'owner_user_id',
  predicate: "s.entity_type = 'Person' AND s.merged_into_entity_id IS NULL",
};

@Injectable()
export class PersonEmbedStage extends DenseEmbedStageBase {
  readonly id = STAGE_IDS.INDEX_EMBED_PERSON;

  readonly entityTypes = ['person'] as const;

  readonly source = INDEX_EMBED_PERSON_SOURCE;

  /** A bare short name is exactly what a person doc looks like — never "too short". */
  protected readonly skipHeuristics = false;

  protected readonly honorsEmbedAllowlist = false;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    embeddingGenerationService: EmbeddingGenerationService,
    logger: LoggerService,
  ) {
    super(dataSource, embeddingGenerationService, logger);
    this.logger.setContext(PersonEmbedStage.name);
  }

  protected async loadDocuments(userId: string, ids: string[]): Promise<EmbedDocumentRow[]> {
    const rows = await loadPersonRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, document: personSearchDocument(row) }));
  }
}

/**
 * Files index from `ci.files` (the table whose ids `FileCreatedEvent` carries
 * and the listener indexes). Originals only: derived variants (thumbnails,
 * transcodes) repeat the original's filename with no text of their own.
 */
export const INDEX_EMBED_FILE_SOURCE: StageSource = {
  schema: 'ci',
  table: 'files',
  idColumn: 'id',
  userColumn: 'user_id',
  predicate: "s.variant = 'ORIGINAL' AND s.deleted_at IS NULL",
};

@Injectable()
export class FileEmbedStage extends DenseEmbedStageBase {
  readonly id = STAGE_IDS.INDEX_EMBED_FILE;

  readonly entityTypes = ['file'] as const;

  readonly source = INDEX_EMBED_FILE_SOURCE;

  protected readonly skipHeuristics = false;

  protected readonly honorsEmbedAllowlist = false;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    embeddingGenerationService: EmbeddingGenerationService,
    logger: LoggerService,
  ) {
    super(dataSource, embeddingGenerationService, logger);
    this.logger.setContext(FileEmbedStage.name);
  }

  protected async loadDocuments(userId: string, ids: string[]): Promise<EmbedDocumentRow[]> {
    const rows = await loadFileRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, document: fileSearchDocument(row) }));
  }
}

export const INDEX_EMBED_BROWSER_ACTIVITY_SOURCE: StageSource = {
  schema: 'ci',
  table: 'browser_activity',
  idColumn: 'id',
  userColumn: 'user_id',
};

@Injectable()
export class BrowserActivityEmbedStage extends DenseEmbedStageBase {
  readonly id = STAGE_IDS.INDEX_EMBED_BROWSER_ACTIVITY;

  readonly entityTypes = ['browser-activity'] as const;

  readonly source = INDEX_EMBED_BROWSER_ACTIVITY_SOURCE;

  protected readonly skipHeuristics = true;

  protected readonly honorsEmbedAllowlist = true;

  constructor(
    @InjectDataSource() dataSource: DataSource,
    embeddingGenerationService: EmbeddingGenerationService,
    logger: LoggerService,
  ) {
    super(dataSource, embeddingGenerationService, logger);
    this.logger.setContext(BrowserActivityEmbedStage.name);
  }

  protected async loadDocuments(userId: string, ids: string[]): Promise<EmbedDocumentRow[]> {
    const rows = await loadBrowserActivityRows(this.dataSource, userId, ids);

    return rows.map((row) => ({ id: row.id, document: browserActivitySearchDocument(row) }));
  }
}
