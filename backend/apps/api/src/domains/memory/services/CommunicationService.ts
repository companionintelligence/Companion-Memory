import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, type FindOptionsOrder } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  INGEST_REFRESH_COLUMNS,
  bulkInsertIdempotent,
  keysetPaginate,
  type KeysetPageArgs,
  type KeysetPage,
} from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { CommunicationBaseEntity } from '../entities/CommunicationBaseEntity';
import { CommunicationEntity, Communication, previewFromContent } from '../entities/CommunicationEntity';
import { CommunicationCreatedEvent, CommunicationUpdatedEvent, CommunicationRemovedEvent } from '../events';
import { CreateCommunicationDto, UpdateCommunicationDto } from '../types';

import { CtiAggregate, type RepositoryProvider } from './CtiAggregate';
import { GraphDeltaWriter } from './GraphDeltaWriter';

interface Options {
  limit?: number;
  order?: FindOptionsOrder<CommunicationEntity>;
  startTime?: Date;
  endTime?: Date;
  /** Composite keyset cursor for the timed search path (see EventService). */
  afterTime?: Date;
  afterId?: string;
}

/**
 * Hourly UTC per-user communication count. Declared locally so this domain
 * carries no dependency on aggregating consumers; they enforce the shape
 * structurally where they consume it.
 */
export interface HourlyCommunicationCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

/**
 * Spanning-aggregate service for the communications CTI split: every
 * `ci.communications` row has a `Communication`-discriminated base row in
 * `ci.entities` sharing its uuid (see {@link CommunicationBaseEntity}). Unlike
 * Item/Event, nothing was normalized away — the base row's `name` is a DERIVED
 * display label re-computed here whenever its source fields change.
 */
@Injectable()
export class CommunicationService {
  private readonly aggregate: CtiAggregate<CommunicationEntity, CommunicationBaseEntity>;

  constructor(
    @InjectRepository(CommunicationEntity)
    private readonly communicationRepository: Repository<CommunicationEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
    private readonly dataSource: DataSource,
    private readonly graphDeltaWriter: GraphDeltaWriter,
  ) {
    this.logger.setContext(CommunicationService.name);
    this.aggregate = new CtiAggregate({
      detailRepository: this.communicationRepository,
      detailEntity: CommunicationEntity,
      baseEntity: CommunicationBaseEntity,
      // No baseRepository: the Communication egress composes from the detail
      // row alone (nothing was normalized away).
      linkedTable: 'communications',
      scopedWhere: (context, id) => ({
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      }),
    });
  }

  /** The base row's derived display label: subject, else preview, else a content clip. */
  private labelFor(entity: Pick<CommunicationEntity, 'subject' | 'preview' | 'content'>): string | null {
    // Importers commonly store no-subject messages as '' (not null); a blank
    // subject/preview must fall through to the next branch, matching the
    // migration backfill's NULLIF(trim(...), '').
    const blankToNull = (value: string | null | undefined): string | null => {
      const trimmed = value?.trim();

      return trimmed ? trimmed : null;
    };

    return blankToNull(entity.subject) ?? blankToNull(entity.preview) ?? previewFromContent(entity.content);
  }

  /** Builds the `ci.entities` half of the aggregate from a (hydrated) detail row. */
  private baseRowFor(manager: RepositoryProvider, entity: CommunicationEntity): CommunicationBaseEntity {
    return this.aggregate.createBaseRow(manager, {
      id: entity.id,
      userId: entity.userId,
      name: this.labelFor(entity),
      description: entity.summary ?? null,
    });
  }

  async create(context: UserServiceContext, data: CreateCommunicationDto): Promise<Communication> {
    const id = data.id ?? uuidv7();

    const communication = this.communicationRepository.create({
      id,
      time: data.time,
      communicationType: data.communication_type,
      userId: context.userId,
      deviceId: data.device_id,
      direction: data.direction,
      threadId: data.thread_id,
      fromEntityId: data.from_entity_id,
      toEntityIds: data.to_entity_ids || [],
      participantsMetadata: data.participants_metadata || {},
      subject: data.subject,
      content: data.content,
      durationSeconds: data.duration_seconds,
      sentimentScore: data.sentiment_score,
      importanceScore: data.importance_score,
      urgencyScore: data.urgency_score,
      category: data.category,
      summary: data.summary,
      connectionId: data.connection_id,
      attachments: data.attachments || [],
      isEncrypted: data.is_encrypted || false,
      isArchived: data.is_archived || false,
      preview: data.preview ?? null,
      sourceType: data.source_type ?? null,
      sourceSystem: data.source_system ?? null,
      sourceId: data.source_id ?? null,
    });

    // People-linking — from_entity_id / to_entity_ids are resolved out-of-band
    // by CommunicationParticipantLinkListener (consuming the
    // CommunicationCreatedEvent emitted below). The listener classifies the
    // raw participants in `participants_metadata`, creates stub Person entities
    // for previously-unseen identifiers, and writes the resolved ids back.
    // Bulk createMany does not emit per-row events, so its rows are linked by
    // the matching backfill pair instead (see MaintenanceController).
    //
    // One transaction across both halves of the CTI aggregate: the base row
    // (derived display label) first, then the detail.
    const communicationResult = await this.communicationRepository.manager.transaction(async (manager) => {
      await manager.getRepository(CommunicationBaseEntity).save(this.baseRowFor(manager, communication));

      const saved = await manager.getRepository(CommunicationEntity).save(communication);
      await this.graphDeltaWriter.entityCreated({
        entityId: id,
        entityType: 'Communication',
        name: this.labelFor(saved),
        description: saved.summary ?? null,
        ownerUserId: context.userId,
        changeSource: 'CommunicationService.create',
        changedByUserId: typeof context.userId === 'string' ? context.userId : null,
        manager,
      });

      return saved;
    });

    await this.eventService.send(CommunicationCreatedEvent, {
      communicationId: communicationResult.id,
    });

    return CommunicationEntity.toEgressType(communicationResult);
  }

  /**
   * Batch, idempotent communication ingest for the importer, keyed on the
   * provenance triple via {@link bulkInsertIdempotent} — the same set-based
   * INSERT ... ON CONFLICT path as content/events/items/browser_activity.
   * The arbiter is communications_source_triple_uniq, the pure
   * `(user_id, source_type, source_system, source_id)` partial unique index:
   * `time` is deliberately NOT part of the key, because the importer cannot
   * keep it stable across re-syncs for sources whose row body lacks a usable
   * timestamp (iMessage attachment-only entries fall back to import
   * wall-clock). A time-bearing key minted 35,018 duplicate rows once — see
   * migration 20260807072321 and docs/architecture/hypertable-audit.md, which
   * de-hypertabled this table precisely so the clean index (and this plain
   * code path) became possible. For the same reason no `timeColumn` bound is
   * passed: a re-sent
   * triple's time may differ from the stored row's, and the plain table needs
   * no chunk exclusion.
   *
   * Re-sends of an existing triple self-heal the source-derived columns
   * (INGEST_REFRESH_COLUMNS.communication) via ON CONFLICT DO UPDATE instead
   * of being a find-or-return no-op.
   *
   * Bulk ingest does NOT emit per-row CommunicationCreatedEvent: at import
   * volume the per-row pgboss fan-out (one job per registered queue per row)
   * was the dominant cost. Search indexing for bulk-loaded rows is deferred to
   * the post-load batch embed (POST /api/maintenance/search-index/backfill).
   * Single-row create() still emits, so interactive creates index live.
   */
  async createMany(context: UserServiceContext, data: CreateCommunicationDto[]): Promise<Communication[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.communicationRepository.create({
        id: item.id ?? uuidv7(),
        time: item.time,
        communicationType: item.communication_type,
        userId: context.userId,
        deviceId: item.device_id,
        direction: item.direction,
        threadId: item.thread_id,
        fromEntityId: item.from_entity_id,
        toEntityIds: item.to_entity_ids || [],
        participantsMetadata: item.participants_metadata || {},
        subject: item.subject,
        content: item.content,
        durationSeconds: item.duration_seconds,
        sentimentScore: item.sentiment_score,
        importanceScore: item.importance_score,
        urgencyScore: item.urgency_score,
        category: item.category,
        summary: item.summary,
        connectionId: item.connection_id,
        attachments: item.attachments || [],
        isEncrypted: item.is_encrypted || false,
        isArchived: item.is_archived || false,
        preview: item.preview ?? null,
        sourceType: item.source_type ?? null,
        sourceSystem: item.source_system ?? null,
        sourceId: item.source_id ?? null,
      }),
    );

    // One transaction spans both halves of the CTI aggregate. The base phase
    // UPSERTS for every result row — not just inserts — because the detail
    // conflict action refreshes subject/preview/content on re-ingest
    // (INGEST_REFRESH_COLUMNS.communication) and the base row's derived label
    // must follow. Labels are derived from the HYDRATED rows, so they reflect
    // what actually landed (refreshed values applied, stored summary kept).
    const results = await this.communicationRepository.manager.transaction(async (manager) => {
      const detailResults = await bulkInsertIdempotent({
        repository: this.communicationRepository,
        manager,
        entities,
        primaryKey: 'id',
        getTriple: (entity) => ({
          sourceType: entity.sourceType,
          sourceSystem: entity.sourceSystem,
          sourceId: entity.sourceId,
        }),
        scope: { userId: context.userId },
        conflictTarget: '(user_id, source_type, source_system, source_id) WHERE source_id IS NOT NULL',
        tripleColumns: ['source_type', 'source_system', 'source_id'],
        conflictUpdateColumns: INGEST_REFRESH_COLUMNS.communication,
      });

      // One base row per distinct id: intra-batch duplicate triples resolve to
      // the same hydrated row, and ON CONFLICT DO UPDATE rejects touching one
      // arbiter row twice in a single statement (SQLSTATE 21000).
      const baseRows = [
        ...new Map(detailResults.map(({ entity }) => [entity.id, this.baseRowFor(manager, entity)])).values(),
      ];

      // The WHERE skips identical-value rewrites: an unchanged re-sync of
      // the largest table in the schema would otherwise churn a dead tuple
      // and a search-vector/GIN recompute per row for no change.
      await this.aggregate.insertBaseRows(
        manager,
        baseRows,
        '(entity_id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description ' +
          'WHERE (entities.name, entities.description) IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.description)',
      );

      await this.graphDeltaWriter.recordMany(
        detailResults
          .filter(({ inserted }) => inserted)
          .map(({ entity }) => ({
            nodeType: 'entity' as const,
            changeType: 'created' as const,
            entityId: entity.id,
            entityType: 'Communication',
            ownerUserId: context.userId,
            changeSource: 'CommunicationService.createMany',
            changedByUserId: typeof context.userId === 'string' ? context.userId : null,
            changedFields: {
              name: { new: this.labelFor(entity) },
              description: { new: entity.summary ?? null },
              entity_type: { new: 'Communication' },
              properties: { new: {} },
            },
          })),
        manager,
      );

      return detailResults;
    });

    return results.map(({ entity }) => CommunicationEntity.toEgressType(entity));
  }

  async findAll(context: UserServiceContext): Promise<Communication[]> {
    const result = await this.communicationRepository.find({
      where: {
        userId: context.userId,
      },
    });

    return result.map((entity) => CommunicationEntity.toEgressType(entity));
  }

  /**
   * Keyset-paginated page for the GraphQL connection — ordered by (time, id)
   * DESC, only one page (+1 sentinel) is read from Postgres via the
   * (user_id, time) index instead of loading every row into memory.
   */
  async findPage(context: UserServiceContext, args: KeysetPageArgs): Promise<KeysetPage<Communication>> {
    const page = await keysetPaginate(this.communicationRepository, args, {
      alias: 'communication',
      timeProp: 'time',
      userId: context.userId,
    });

    return {
      ...page,
      entities: page.entities.map((entity) => CommunicationEntity.toEgressType(entity)),
    };
  }

  async findById(context: ServiceContext, id: string): Promise<Communication | null> {
    const result = await this.communicationRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return result ? CommunicationEntity.toEgressType(result) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Communication | null)[]> {
    const result = await this.communicationRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(result.map((entity) => [entity.id, CommunicationEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  async update(
    context: ServiceContext,
    id: string,
    data: UpdateCommunicationDto,
  ): Promise<Communication | null> {
    const updateData: Partial<CommunicationEntity> = {};

    if (data.device_id) {
      updateData.deviceId = data.device_id;
    }

    if (data.direction) {
      updateData.direction = data.direction;
    }

    if (data.thread_id) {
      updateData.threadId = data.thread_id;
    }

    if (data.from_entity_id) {
      updateData.fromEntityId = data.from_entity_id;
    }

    if (data.to_entity_ids) {
      updateData.toEntityIds = data.to_entity_ids;
    }

    if (data.participants_metadata) {
      updateData.participantsMetadata = data.participants_metadata;
    }

    if (data.subject) {
      updateData.subject = data.subject;
    }

    if (data.content) {
      updateData.content = data.content;
    }

    if (data.attachments) {
      updateData.attachments = data.attachments;
    }

    if (data.duration_seconds) {
      updateData.durationSeconds = data.duration_seconds;
    }

    if (data.sentiment_score) {
      updateData.sentimentScore = data.sentiment_score;
    }

    if (data.importance_score) {
      updateData.importanceScore = data.importance_score;
    }

    if (data.urgency_score) {
      updateData.urgencyScore = data.urgency_score;
    }

    if (data.category) {
      updateData.category = data.category;
    }

    if (data.summary) {
      updateData.summary = data.summary;
    }

    if (data.connection_id) {
      updateData.connectionId = data.connection_id;
    }

    if (data.is_encrypted) {
      updateData.isEncrypted = data.is_encrypted;
    }

    if (data.is_archived) {
      updateData.isArchived = data.is_archived;
    }

    // (Previously compared against the STRING 'undefined', which is always
    // true — the guard never guarded.)
    if (data.preview !== undefined) {
      updateData.preview = data.preview;
    }

    // One transaction across both halves of the aggregate; when any source of
    // the derived label (subject/preview/content) or of the description
    // (summary) changed, the base row is re-derived from the updated detail.
    const labelSourcesTouched =
      data.subject !== undefined ||
      data.preview !== undefined ||
      data.content !== undefined ||
      data.summary !== undefined;

    const updated = await this.aggregate.applyUpdate(
      context,
      id,
      {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        detail: updateData as any, // TypeORM will handle JSON serialization
        // The base patch derives from the PATCHED detail values, so the label
        // reflects what is actually being persisted.
        base: labelSourcesTouched
          ? (after) => ({
              name: this.labelFor(after),
              description: after.summary ?? null,
            })
          : undefined,
      },
      {
        withinTx: async ({ manager, after }) => {
          if (!after) {
            return;
          }

          await this.graphDeltaWriter.entityUpdated({
            entityId: id,
            entityType: 'Communication',
            name: this.labelFor(after),
            changedFields: {
              name: { new: this.labelFor(after) },
              ...(Object.keys(updateData).length > 0 ? { detail_updated: { new: true } } : {}),
            },
            ownerUserId: typeof context.userId === 'string' ? context.userId : null,
            changeSource: 'CommunicationService.update',
            changedByUserId: typeof context.userId === 'string' ? context.userId : null,
            manager,
          });
        },
      },
    );

    if (!updated) {
      return null;
    }

    await this.eventService.send(CommunicationUpdatedEvent, {
      communicationId: id,
    });

    // The transaction already reloaded the detail row; the Communication
    // egress composes from it alone.
    return CommunicationEntity.toEgressType(updated);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    // Authorized load + base-row delete — the communications_id_entities_fk
    // ON DELETE CASCADE removes the detail in the same statement.
    const removed = await this.aggregate.remove(context, id, {
      withinTx: async ({ manager, before }) => {
        await this.graphDeltaWriter.entityDeleted({
          entityId: id,
          entityType: 'Communication',
          name: this.labelFor(before),
          ownerUserId: context.userId !== SYSTEM_USER ? context.userId : before.userId,
          changeSource: 'CommunicationService.remove',
          changedByUserId: typeof context.userId === 'string' ? context.userId : null,
          manager,
        });
      },
    });

    if (!removed) {
      return false;
    }

    await this.eventService.send(CommunicationRemovedEvent, {
      communicationId: id,
    });

    return true;
  }

  async findByThreadId(context: ServiceContext, threadId: string): Promise<CommunicationEntity[]> {
    return this.communicationRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
        threadId: threadId,
      },
      order: { time: 'ASC' },
    });
  }

  async findByUserId(context: UserServiceContext, limit = 100): Promise<CommunicationEntity[]> {
    return this.communicationRepository.find({
      where: {
        userId: context.userId,
      },
      order: { time: 'DESC' },
      take: limit,
    });
  }

  async getEntitiesForCommunications(
    context: ServiceContext,
    options: Options,
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.dataSource
      .getRepository(CommunicationEntity)
      .createQueryBuilder('communications')
      .select(['communications.id'])
      .where('communications.user_id = :userId', { userId: context.userId });

    if (options.limit) {
      query = query.limit(options.limit);
    }

    if (options.order) {
      for (const [field, direction] of Object.entries(options.order)) {
        query = query.orderBy(`communications.${field}`, direction as 'ASC' | 'DESC');
      }

      // Deterministic tiebreak so same-timestamp rows page consistently.
      query = query.addOrderBy('communications.id', 'DESC');
    }

    // Composite keyset: page strictly past (afterTime, afterId) in (time DESC, id DESC).
    if (options.afterTime && options.afterId) {
      query = query.andWhere(
        '(communications.time < :afterTime OR (communications.time = :afterTime AND communications.id < :afterId))',
        { afterTime: options.afterTime, afterId: options.afterId },
      );
    }

    if (options.startTime) {
      query = query.andWhere('communications.time >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('communications.time <= :endTime', { endTime: options.endTime });
    }

    const results = await query.getRawMany();

    return results.map((row: { communications_id: string; type: IndexableEntity }) => ({
      id: row.communications_id,
      type: 'communication' as IndexableEntity,
    }));
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: communications
   * counted by their event `time`, per user.
   */
  async aggregateHourlyActivity(): Promise<HourlyCommunicationCount[]> {
    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> =
      await this.communicationRepository
        .createQueryBuilder('communication')
        .select('communication.userId', 'user_id')
        .addSelect(`date_trunc('hour', communication.time, 'UTC')`, 'bucket_start')
        .addSelect('COUNT(*)::int', 'count')
        .groupBy('user_id')
        .addGroupBy('bucket_start')
        .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}
