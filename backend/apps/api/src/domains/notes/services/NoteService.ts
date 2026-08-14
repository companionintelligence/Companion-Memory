import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { SYSTEM_USER, UserServiceContext, type ServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { computeChunkSize } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import type { EntityIdentifier, IndexableEntity } from '@ci/domains/search-next';

import { type Note, NoteEntity } from '../entities/NoteEntity';
import { NoteCreatedEvent, NoteUpdatedEvent, NoteRemovedEvent } from '../events';
import type { CaptureNoteDto, CaptureNoteResult, CreateNoteDto, UpdateNoteDto } from '../types';

/**
 * Hourly UTC per-user note count. Declared locally so this domain carries no
 * dependency on aggregating consumers; they enforce the shape structurally
 * where they consume it.
 */
export interface HourlyNoteCount {
  userId: string;
  bucketStart: Date;
  count: number;
}

@Injectable()
export class NoteService {
  constructor(
    @InjectRepository(NoteEntity)
    private readonly noteRepository: Repository<NoteEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(NoteService.name);
  }

  /**
   * @param options.emitCreated When true (default) a NoteCreatedEvent is sent so the
   *   row indexes/enriches live. The bulk path passes false: emitting a per-row
   *   pgboss event for every ingested row is the dominant cost at import volume, so
   *   bulk-loaded rows are instead swept by the post-load search-index backfill.
   */
  async create(
    context: UserServiceContext,
    data: CreateNoteDto,
    options: { emitCreated?: boolean } = {},
  ): Promise<Note | null> {
    const { emitCreated = true } = options;

    const record = this.noteRepository.create({
      id: data.id || uuidv7(),
      ...data,
      userId: context.userId,
    });

    const entity = await this.noteRepository.save(record);

    if (emitCreated) {
      await this.eventService.send(NoteCreatedEvent, {
        noteId: entity.id,
      });
    }

    return NoteEntity.toEgressType(entity);
  }

  /**
   * Batch notes ingest for the importer. Replaces the per-row save +
   * NoteCreatedEvent loop with one set-based INSERT plus one hydration SELECT.
   * Notes have no dedup key, so this is a plain multi-row INSERT — every input
   * row is inserted. Returns the created notes in input order.
   *
   * Bulk ingest does NOT emit a per-row NoteCreatedEvent: the per-row pgboss
   * fan-out was the dominant cost at import volume. Search indexing for
   * bulk-loaded rows is deferred to the post-load batch embed
   * (POST /api/maintenance/search-index/backfill). Single-row create() still
   * emits, so interactive creates index live.
   */
  async createMany(context: UserServiceContext, data: CreateNoteDto[]): Promise<Note[]> {
    if (data.length === 0) {
      return [];
    }

    const entities = data.map((item) =>
      this.noteRepository.create({
        id: item.id || uuidv7(),
        ...item,
        userId: context.userId,
      }),
    );

    // Split into param-budget-bounded chunks so a large batch never exceeds
    // Postgres' 65535 bind-param limit (computeChunkSize is the same helper
    // bulkInsertIdempotent uses). Notes have no dedup key, so every chunk is a
    // plain multi-row INSERT.
    const chunkSize = computeChunkSize(this.noteRepository.metadata.columns.length);
    for (let offset = 0; offset < entities.length; offset += chunkSize) {
      await this.noteRepository
        .createQueryBuilder()
        .insert()
        // Route through `metadata.target` so TS picks the `ObjectLiteral` overload
        // of `.values()` (matches the other bulk-ingest services).
        .into(this.noteRepository.metadata.target)
        .values(entities.slice(offset, offset + chunkSize))
        .execute();
    }

    const ids = entities.map((entity) => entity.id);
    const rows = await this.noteRepository.find({ where: { id: In(ids) } });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return entities.map((entity) => NoteEntity.toEgressType(byId.get(entity.id) ?? entity));
  }

  /**
   * Idempotent upsert of **client-minted** notes — the replay target for the
   * durable capture outbox (`POST /v1/notes`).
   *
   * Unlike {@link createMany}, which is the importer's plain multi-row INSERT,
   * every input here carries an `id` the client generated *before* the note was
   * queued. That is the whole point: an offline note has a real identity from
   * the moment it is written, so nothing has to be reconciled when it lands.
   * Three consequences, and each is a guard below rather than an assumption:
   *
   * 1. **Replay must be free.** Outbox delivery is deliberately at-least-once,
   *    so the same note arrives twice whenever an `/attempt` report is lost. A
   *    plain INSERT would raise a unique violation, which the client flusher
   *    reads as a 5xx-class transient failure and retries to exhaustion — a
   *    successfully-stored note parked in `needs_attention`. Hence ON CONFLICT.
   * 2. **A client-supplied id must never reach another user's row.** The
   *    interactive path is safe by construction (the server mints the id), but
   *    once the client names it, `repository.save()` is not: with the primary
   *    key set it UPDATEs whatever row it finds, unscoped by owner, so a
   *    colliding id would rewrite a stranger's note *and* reassign `user_id`.
   *    The `n.user_id = EXCLUDED.user_id` predicate is what makes that
   *    impossible; conflicted ids are reported, never written.
   * 3. **A stale snapshot must not clobber newer content.** A note edited on
   *    another client (or online, through `updateNote`) while an older snapshot
   *    sat in the queue is the ordinary case, not the exotic one. The
   *    `n.updated_at < EXCLUDED.updated_at` predicate makes the write
   *    last-write-wins on the CLIENT capture instant.
   *
   * `created_at` comes from the capture instant too, and only on the insert
   * branch — a note written offline last night belongs to last night on the
   * timeline, and the earliest snapshot to land is the one that says when.
   *
   * Emits per row (`NoteCreatedEvent` / `NoteUpdatedEvent`), unlike the other
   * `/v1` bulk kinds. These are interactive captures replayed a few at a time,
   * not an import, so live indexing costs nothing here — and it is the only way
   * they get indexed at all: `note` is in INDEXABLE_ENTITIES but NOT in
   * BACKFILLABLE_ENTITIES, so the deferred `search_index` sweep cannot reach
   * them. A drained note therefore ends up in exactly the state it would have
   * been in had the user been online.
   */
  async captureMany(context: UserServiceContext, data: CaptureNoteDto[]): Promise<CaptureNoteResult> {
    const result: CaptureNoteResult = { created: [], updated: [], stale: [], conflicted: [] };

    if (data.length === 0) {
      return result;
    }

    // Collapse repeats within one request to the newest snapshot per id, so a
    // batch behaves identically to the same snapshots arriving one at a time.
    const newestById = new Map<string, CaptureNoteDto>();
    for (const note of data) {
      const seen = newestById.get(note.id);

      if (!seen || seen.capturedAt.getTime() <= note.capturedAt.getTime()) {
        newestById.set(note.id, note);
      }
    }

    const notes = [...newestById.values()];

    // Classify against what is already stored. The SQL predicates below are the
    // authority — this read only decides which rows are worth sending and
    // whether a write is a create or an update (which event to emit). A row
    // that changes underneath us between the two statements still cannot be
    // written incorrectly; it just falls out as `stale`.
    const existing: Array<{ id: string; user_id: string; updated_at: Date }> =
      await this.noteRepository.manager.query(
        `SELECT id, user_id, updated_at FROM ci.notes WHERE id = ANY($1::uuid[])`,
        [notes.map((note) => note.id)],
      );

    const stored = new Map(existing.map((row) => [row.id, row]));
    const candidates: CaptureNoteDto[] = [];
    const expectUpdate = new Set<string>();

    for (const note of notes) {
      const row = stored.get(note.id);

      if (!row) {
        candidates.push(note);

        continue;
      }

      if (row.user_id !== context.userId) {
        result.conflicted.push(note.id);

        continue;
      }

      if (new Date(row.updated_at).getTime() >= note.capturedAt.getTime()) {
        result.stale.push(note.id);

        continue;
      }

      expectUpdate.add(note.id);
      candidates.push(note);
    }

    if (candidates.length === 0) {
      return result;
    }

    const written = new Set<string>();
    // 6 binds per row; same param-budget helper the bulk insert path uses.
    const chunkSize = computeChunkSize(this.noteRepository.metadata.columns.length);

    for (let offset = 0; offset < candidates.length; offset += chunkSize) {
      const chunk = candidates.slice(offset, offset + chunkSize);
      const params: unknown[] = [];
      const values = chunk.map((note) => {
        params.push(note.id, note.title ?? null, note.content ?? null, context.userId, note.capturedAt);
        const base = params.length - 5;

        return `($${base + 1}::uuid, $${base + 2}, $${base + 3}, $${base + 4}::uuid, $${base + 5}::timestamptz, $${base + 5}::timestamptz)`;
      });

      const rows: Array<{ id: string }> = await this.noteRepository.manager.query(
        `INSERT INTO ci.notes AS n (id, title, content, user_id, created_at, updated_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (id) DO UPDATE
            SET title      = EXCLUDED.title,
                content    = EXCLUDED.content,
                updated_at = EXCLUDED.updated_at
          WHERE n.user_id = EXCLUDED.user_id
            AND n.updated_at < EXCLUDED.updated_at
         RETURNING id`,
        params,
      );

      for (const row of rows) {
        written.add(row.id);
      }
    }

    for (const note of candidates) {
      if (!written.has(note.id)) {
        // Expected to write and did not: another writer got there first with
        // something at least as new. Benign, and the same outcome as `stale`.
        result.stale.push(note.id);

        continue;
      }

      if (expectUpdate.has(note.id)) {
        result.updated.push(note.id);
      } else {
        result.created.push(note.id);
      }
    }

    for (const id of result.created) {
      await this.eventService.send(NoteCreatedEvent, { noteId: id });
    }

    for (const id of result.updated) {
      await this.eventService.send(NoteUpdatedEvent, { noteId: id });
    }

    if (result.conflicted.length > 0) {
      this.logger.warn(
        `Refused ${result.conflicted.length} captured note(s) whose id belongs to another user.`,
      );
    }

    return result;
  }

  async findById(context: ServiceContext, id: string): Promise<Note | null> {
    const entity = await this.noteRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    return entity ? NoteEntity.toEgressType(entity) : null;
  }

  async findByIds(context: ServiceContext, ids: string[]): Promise<(Note | null)[]> {
    const results = await this.noteRepository.find({
      where: {
        id: In(ids),
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    const map = new Map(results.map((entity) => [entity.id, NoteEntity.toEgressType(entity)]));

    return ids.map((id) => map.get(id) ?? null);
  }

  /**
   * Lightweight identifiers for the most-recent notes, for the unified
   * search/explorer feed. Full entities are batch-resolved downstream.
   */
  async getEntitiesForNotes(
    context: ServiceContext,
    options: { limit?: number; startTime?: Date; endTime?: Date; order?: 'ASC' | 'DESC' } = {},
  ): Promise<EntityIdentifier<IndexableEntity>[]> {
    let query = this.noteRepository
      .createQueryBuilder('note')
      .select('note.id', 'id')
      .where('note.user_id = :userId', { userId: context.userId });

    if (options.startTime) {
      query = query.andWhere('note.created_at >= :startTime', { startTime: options.startTime });
    }

    if (options.endTime) {
      query = query.andWhere('note.created_at <= :endTime', { endTime: options.endTime });
    }

    query = query.orderBy('note.created_at', options.order ?? 'DESC');

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const rows = await query.getRawMany<{ id: string }>();

    return rows.map((row) => ({ id: row.id, type: 'note' as IndexableEntity }));
  }

  async findAll(context: ServiceContext): Promise<Note[]> {
    const results = await this.noteRepository.find({
      where: {
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
      order: {
        updatedAt: 'DESC',
      },
    });

    return results.map((entity) => NoteEntity.toEgressType(entity));
  }

  async update(context: ServiceContext, id: string, data: UpdateNoteDto): Promise<Note | null> {
    const record = await this.noteRepository.findOne({
      where: {
        id,
        ...(context.userId !== SYSTEM_USER && {
          userId: context.userId,
        }),
      },
    });

    if (record == null) {
      return null;
    }

    Object.assign(record, data);

    const updatedEntity = await this.noteRepository.save(record);

    await this.eventService.send(NoteUpdatedEvent, {
      noteId: updatedEntity.id,
    });

    return NoteEntity.toEgressType(updatedEntity);
  }

  async remove(context: ServiceContext, id: string): Promise<boolean> {
    const result = await this.noteRepository.delete({
      id,
      ...(context.userId !== SYSTEM_USER && {
        userId: context.userId,
      }),
    });

    if (result.affected != null && result.affected > 0) {
      await this.eventService.send(NoteRemovedEvent, {
        noteId: id,
      });

      return true;
    }

    return false;
  }

  /**
   * Hourly UTC activity buckets for the activity rollup: notes counted by
   * creation time, per user.
   */
  async aggregateHourlyActivity(): Promise<HourlyNoteCount[]> {
    const rows: Array<{ user_id: string; bucket_start: Date; count: number }> = await this.noteRepository
      .createQueryBuilder('note')
      .select('note.userId', 'user_id')
      .addSelect(`date_trunc('hour', note.createdAt, 'UTC')`, 'bucket_start')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('user_id')
      .addGroupBy('bucket_start')
      .getRawMany();

    return rows.map((row) => ({ userId: row.user_id, bucketStart: row.bucket_start, count: row.count }));
  }
}
