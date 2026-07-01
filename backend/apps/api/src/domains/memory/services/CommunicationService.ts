import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, In, type FindOptionsOrder } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type ServiceContext, type UserServiceContext, SYSTEM_USER } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { CommunicationEntity, Communication } from '../entities/CommunicationEntity';
import { CommunicationCreatedEvent, CommunicationUpdatedEvent, CommunicationRemovedEvent } from '../events';
import { CreateCommunicationDto, UpdateCommunicationDto } from '../types';

interface Options {
  limit?: number;
  order?: FindOptionsOrder<CommunicationEntity>;
  startTime?: Date;
  endTime?: Date;
  /** Composite keyset cursor for the timed search path (see EventService). */
  afterTime?: Date;
  afterId?: string;
}

@Injectable()
export class CommunicationService {
  constructor(
    @InjectRepository(CommunicationEntity)
    private readonly communicationRepository: Repository<CommunicationEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
    private readonly dataSource: DataSource,
  ) {
    this.logger.setContext(CommunicationService.name);
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
    const communicationResult = await this.communicationRepository.save(communication);

    await this.eventService.send(CommunicationCreatedEvent, {
      communicationId: communicationResult.id,
    });

    return CommunicationEntity.toEgressType(communicationResult);
  }

  /**
   * Batch, idempotent communication ingest for the importer.
   *
   * Why this isn't a plain INSERT ... ON CONFLICT like the other ingest paths:
   * ci.communications is a TimescaleDB hypertable partitioned on (time, user_id),
   * and TimescaleDB rejects every UNIQUE index that doesn't include both
   * partition columns (`cannot create a unique index without the column "time"
   * (used in partitioning)`). The old guard `communications_source_triple_uniq`
   * therefore carried `time`, which the importer is NOT able to keep stable for
   * sources whose row body lacks a usable timestamp (iMessage attachment-only
   * entries fall back to import wall-clock). Two import sweeps days apart
   * minted duplicate rows for the same provenance triple — 27,700 imessage,
   * 7,318 google_voice on a real local DB.
   *
   * The fix moves the idempotency invariant onto ci.communications_source_dedup,
   * a non-hypertable companion table whose PRIMARY KEY is the pure provenance
   * triple `(user_id, source_type, source_system, source_id)` — no `time` in
   * the key. This method claims dedup rows for the batch's triples first; only
   * the winners get an INSERT into ci.communications. Losers (triples already
   * claimed) optionally refresh the canonical row's self-heal fields, mirroring
   * the previous ON CONFLICT DO UPDATE behaviour. An AFTER DELETE trigger on
   * ci.communications drops the dedup row so any future re-ingest of the same
   * triple is treated as new (see migration 20260628120000).
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

    // The partial unique index was `WHERE source_id IS NOT NULL`; we require
    // the full (type, system, id) trio so the dedup PK is satisfiable.
    const isDedupable = (e: CommunicationEntity): boolean =>
      e.sourceId != null && e.sourceType != null && e.sourceSystem != null;

    const tripleKey = (e: {
      sourceType: string | null;
      sourceSystem: string | null;
      sourceId: string | null;
    }): string => `${e.sourceType ?? ''}||${e.sourceSystem ?? ''}||${e.sourceId ?? ''}`;

    // Intra-batch collapse: two input rows sharing a triple resolve to the
    // same canonical row. Postgres' INSERT ... ON CONFLICT DO NOTHING would
    // silently keep only the first either way, but doing it client-side keeps
    // the round-trip parameter count linear in unique triples (not duplicates).
    const seenIntraBatch = new Set<string>();
    const dedupableUnique: CommunicationEntity[] = [];
    const nonDedupable: CommunicationEntity[] = [];

    for (const entity of entities) {
      if (!isDedupable(entity)) {
        nonDedupable.push(entity);
        continue;
      }

      const key = tripleKey(entity);
      if (seenIntraBatch.has(key)) {
        continue;
      }

      seenIntraBatch.add(key);
      dedupableUnique.push(entity);
    }

    type CanonicalRow = {
      canonicalId: string;
      canonicalTime: Date;
      won: boolean;
    };

    const canonicalByTriple = new Map<string, CanonicalRow>();
    // Refreshable, source-derived columns. Same set as the previous
    // ON CONFLICT DO UPDATE list: a re-sync of these via the canonical row
    // self-heals e.g. the importer's corrected email `direction` or a
    // newly-populated `participants_metadata`. Never extend this with
    // server-mutable columns — a re-import would clobber local edits.
    const selfHealColumns = ['direction', 'participants_metadata', 'content', 'preview', 'subject'] as const;

    await this.dataSource.transaction(async (manager) => {
      if (dedupableUnique.length > 0) {
        // Step 1: claim triples in the dedup table. The CTE returns one row
        // per input triple with the canonical (communication_id, time) and a
        // `won` flag — true if THIS statement claimed the triple (a row to
        // INSERT into ci.communications), false if a previous ingest already
        // owned it (a row to optionally self-heal).
        const claimParams: unknown[] = [];
        const claimValueClauses = dedupableUnique
          .map((entity, i) => {
            const offset = i * 6;
            claimParams.push(
              context.userId,
              entity.sourceType,
              entity.sourceSystem,
              entity.sourceId,
              entity.id,
              entity.time,
            );

            return (
              `($${offset + 1}::uuid, $${offset + 2}::text, $${offset + 3}::text,` +
              ` $${offset + 4}::text, $${offset + 5}::uuid, $${offset + 6}::timestamptz)`
            );
          })
          .join(', ');

        const claimSql = `
          WITH input (user_id, source_type, source_system, source_id, communication_id, communication_time) AS (
            VALUES ${claimValueClauses}
          ),
          upserted AS (
            INSERT INTO ci.communications_source_dedup
                (user_id, source_type, source_system, source_id, communication_id, communication_time)
            SELECT user_id, source_type, source_system, source_id, communication_id, communication_time
              FROM input
            ON CONFLICT (user_id, source_type, source_system, source_id) DO NOTHING
            RETURNING user_id, source_type, source_system, source_id, communication_id, communication_time
          )
          SELECT i.source_type,
                 i.source_system,
                 i.source_id,
                 COALESCE(u.communication_id, d.communication_id)     AS communication_id,
                 COALESCE(u.communication_time, d.communication_time) AS communication_time,
                 (u.communication_id IS NOT NULL)                     AS won
            FROM input i
            LEFT JOIN upserted u
              ON u.user_id = i.user_id
             AND u.source_type = i.source_type
             AND u.source_system = i.source_system
             AND u.source_id = i.source_id
            LEFT JOIN ci.communications_source_dedup d
              ON d.user_id = i.user_id
             AND d.source_type = i.source_type
             AND d.source_system = i.source_system
             AND d.source_id = i.source_id
        `;

        const rawRows = (await manager.query(claimSql, claimParams)) as Array<{
          source_type: string;
          source_system: string;
          source_id: string;
          communication_id: string;
          communication_time: Date | string;
          won: boolean;
        }>;

        for (const row of rawRows) {
          canonicalByTriple.set(
            tripleKey({
              sourceType: row.source_type,
              sourceSystem: row.source_system,
              sourceId: row.source_id,
            }),
            {
              canonicalId: row.communication_id,
              canonicalTime:
                row.communication_time instanceof Date
                  ? row.communication_time
                  : new Date(row.communication_time),
              won: row.won,
            },
          );
        }
      }

      // Step 2: insert the winners (and all non-dedupable rows, which sit
      // outside the source_id-keyed invariant entirely). `insert()` skips the
      // per-row RETURNING + change-set machinery `save()` would do.
      const toInsert: CommunicationEntity[] = [...nonDedupable];
      for (const entity of dedupableUnique) {
        const canonical = canonicalByTriple.get(tripleKey(entity));
        if (canonical?.won) {
          toInsert.push(entity);
        }
      }

      if (toInsert.length > 0) {
        // Match bulkInsertIdempotent: route through `meta.target` so TS picks
        // the `ObjectLiteral` overload of `.values()`. Passing the entity class
        // directly narrows the type to `_QueryDeepPartialEntity<Entity>`, which
        // rejects nullable jsonb columns like `participantsMetadata`.
        await manager
          .createQueryBuilder()
          .insert()
          .into(this.communicationRepository.metadata.target)
          .values(toInsert)
          .execute();
      }

      // Step 3: refresh self-heal columns on losers. Done as a single
      // UPDATE ... FROM (VALUES ...) so the per-batch round-trip stays O(1).
      const losers = dedupableUnique
        .map((entity) => {
          const canonical = canonicalByTriple.get(tripleKey(entity));

          return canonical && !canonical.won ? { entity, canonical } : null;
        })
        .filter((v): v is { entity: CommunicationEntity; canonical: CanonicalRow } => v !== null);

      if (losers.length > 0) {
        const updateParams: unknown[] = [];
        const updateValueClauses = losers
          .map(({ entity, canonical }, i) => {
            const offset = i * 7;
            updateParams.push(
              canonical.canonicalId,
              canonical.canonicalTime,
              entity.direction,
              JSON.stringify(entity.participantsMetadata ?? {}),
              entity.content,
              entity.preview,
              entity.subject,
            );

            return (
              // direction is the enum ci.communication_direction — cast the
              // param to it explicitly (schema-qualified so it resolves
              // regardless of search_path), not ::text.
              `($${offset + 1}::uuid, $${offset + 2}::timestamptz, $${offset + 3}::ci.communication_direction,` +
              ` $${offset + 4}::jsonb, $${offset + 5}::text, $${offset + 6}::text, $${offset + 7}::text)`
            );
          })
          .join(', ');

        updateParams.push(context.userId);
        const userIdParam = `$${updateParams.length}::uuid`;

        const setClauses = selfHealColumns.map((col) => `"${col}" = v.${col}`).join(', ');

        await manager.query(
          `
            UPDATE ci.communications c
               SET ${setClauses}
              FROM (VALUES ${updateValueClauses}) AS v (id, time, direction, participants_metadata, content, preview, subject)
             WHERE c.id = v.id
               AND c.time = v.time
               AND c.user_id = ${userIdParam}
          `,
          updateParams,
        );
      }
    });

    // Hydrate every canonical row this call resolved (winners we just
    // inserted, losers whose canonical row may have just been self-healed,
    // non-dedupable rows). Bound on time for hypertable chunk exclusion — the
    // canonical times either match the input time (winners + non-dedupable)
    // or come from the dedup pointer (losers), and both are present locally.
    const canonicalRows: Array<{ id: string; time: Date }> = [];
    for (const entity of nonDedupable) {
      canonicalRows.push({ id: entity.id, time: entity.time });
    }

    for (const entity of dedupableUnique) {
      const canonical = canonicalByTriple.get(tripleKey(entity));
      if (canonical) {
        canonicalRows.push({ id: canonical.canonicalId, time: canonical.canonicalTime });
      }
    }

    const hydratedById = new Map<string, CommunicationEntity>();
    if (canonicalRows.length > 0) {
      const ids = canonicalRows.map((row) => row.id);
      let minTime = canonicalRows[0].time;
      let maxTime = canonicalRows[0].time;
      for (const row of canonicalRows) {
        if (row.time < minTime) {
          minTime = row.time;
        }

        if (row.time > maxTime) {
          maxTime = row.time;
        }
      }

      const hydrated = await this.communicationRepository
        .createQueryBuilder('c')
        .where('c.user_id = :userId', { userId: context.userId })
        .andWhere('c.id IN (:...ids)', { ids })
        .andWhere('c.time BETWEEN :minTime AND :maxTime', { minTime, maxTime })
        .getMany();

      for (const row of hydrated) {
        hydratedById.set(row.id, row);
      }
    }

    return entities.map((entity) => {
      if (!isDedupable(entity)) {
        return CommunicationEntity.toEgressType(hydratedById.get(entity.id) ?? entity);
      }

      const canonical = canonicalByTriple.get(tripleKey(entity));
      if (!canonical) {
        return CommunicationEntity.toEgressType(hydratedById.get(entity.id) ?? entity);
      }

      const hydrated = hydratedById.get(canonical.canonicalId);

      return CommunicationEntity.toEgressType(hydrated ?? entity);
    });
  }

  async findAll(context: UserServiceContext): Promise<Communication[]> {
    const result = await this.communicationRepository.find({
      where: {
        userId: context.userId,
      },
    });

    return result.map((entity) => CommunicationEntity.toEgressType(entity));
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

    console.log('update', data);

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

    if (data.preview !== 'undefined') {
      updateData.preview = data.preview;
    }

    const communication = await this.communicationRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    console.log('existing communnication', communication);

    if (communication) {
      Object.assign(communication, updateData);
      console.log('communication update', communication);
      await this.communicationRepository.save(communication);
    } else {
      return null;
    }

    await this.eventService.send(CommunicationUpdatedEvent, {
      communicationId: id,
    });

    return this.findById(context, id);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const communication = await this.communicationRepository.findOne({
      where: {
        id: id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (!communication) {
      return false;
    }

    await this.communicationRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

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
}
