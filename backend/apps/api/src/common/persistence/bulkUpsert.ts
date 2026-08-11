import type {
  EntityManager,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
  WhereExpressionBuilder,
} from 'typeorm';
import { Brackets } from 'typeorm';

/**
 * The (source_type, source_system, source_id) provenance triple a capture source
 * carries. Re-ingesting the same triple must be a no-op (find-or-return), which is
 * what the *_source_triple_uniq partial unique indexes enforce.
 */
export interface SourceTriple {
  sourceType: string | null | undefined;
  sourceSystem: string | null | undefined;
  sourceId: string | null | undefined;
}

/** One result row plus whether THIS call inserted it (vs. found it pre-existing). */
export interface BulkInsertResult<Entity> {
  entity: Entity;
  /** True only when this call's INSERT created the row — gates *CreatedEvent emission. */
  inserted: boolean;
}

interface BulkInsertOptions<Entity extends ObjectLiteral> {
  repository: Repository<Entity>;
  /**
   * Entities already built via `repository.create(...)`, in input order. Each MUST
   * have its primary key assigned (the ingest services generate a uuid) so the
   * post-insert hydration SELECT can find it.
   */
  entities: Entity[];
  /** Extracts the provenance triple from a built entity. */
  getTriple: (entity: Entity) => SourceTriple;
  /** Property name of the entity's primary key (e.g. 'id'). */
  primaryKey: keyof Entity & string;
  /**
   * Entity-property/value pairs scoping the existence + hydration queries to the
   * requesting user (and, for the communications hypertable, never `time` — the
   * triple alone is matched and `time` is part of the unique index but not needed
   * to scope reads). Matched with `=`.
   */
  scope: Record<string, unknown>;
  /**
   * The ON CONFLICT arbiter: the EXACT target-and-predicate of the partial unique
   * index, e.g. `(user_id, source_type, source_system, source_id) WHERE source_id
   * IS NOT NULL`. Postgres infers the partial index only when both the columns and
   * the predicate match, so this is emitted verbatim (DO NOTHING is appended).
   */
  conflictTarget: string;
  /** DB column names of the triple, in (type, system, id) order, for the match SQL. */
  tripleColumns: [string, string, string];
  /**
   * Optional list of DB column names to refresh on conflict (an empty list is
   * the same as omitting it — see INGEST_REFRESH_COLUMNS, the central per-entity
   * source of these lists). When non-empty, the
   * INSERT emits `ON CONFLICT (<arbiter>) DO UPDATE SET col = EXCLUDED.col, ...`
   * for these columns instead of `DO NOTHING`, so a re-ingest of the same triple
   * self-heals source-derived mutable fields (e.g. the importer's corrected email
   * `direction`, or a newly-populated `participants_metadata`) rather than being a
   * no-op. List ONLY source-derived mutable columns — never the identity/arbiter
   * columns (id, time, user_id, source_*), and never columns a user may edit
   * server-side (a re-sync would clobber those). When omitted, the legacy
   * `DO NOTHING` find-or-return behaviour is kept verbatim.
   *
   * Idempotency is preserved either way (the arbiter still prevents duplicate
   * rows); the only difference is whether the conflicting row is left untouched
   * or refreshed. Inserted-vs-updated is still distinguished correctly so a
   * *CreatedEvent fires for genuine inserts only (see `RETURNING (xmax = 0)`).
   */
  conflictUpdateColumns?: readonly string[];
  /**
   * Optional partition-time column (entity property). When set, the existence and
   * hydration SELECTs are bounded to the batch's [min, max] of this column so a
   * TimescaleDB hypertable can exclude non-matching chunks instead of scanning
   * every chunk — that all-chunks Append plan over the triple-OR / id-IN predicate
   * both is slow and SEGFAULTS TimescaleDB 2.28. Safe because every row this batch
   * touches (a pre-existing row matched by triple, or one we inserted by id) shares
   * the input row's time, so the bound never excludes a relevant row.
   */
  timeColumn?: keyof Entity & string;
  /**
   * Optional hard ceiling on how many input rows go into a single multi-row INSERT
   * statement. The effective size is the smaller of this and the param-budget cap
   * derived from the entity's column count (see MAX_BIND_PARAM_BUDGET), so a caller
   * can lower it further (e.g. to bound lock-hold time on a hot table) but never
   * raise it past what the 65535 bind-param limit allows. Defaults to
   * DEFAULT_CHUNK_ROWS when omitted. Must be >= 1.
   */
  maxRowsPerChunk?: number;
  /**
   * Optional transactional EntityManager to run inside. When supplied, the whole
   * statement sequence joins the CALLER's transaction instead of opening its own,
   * so a caller can compose this with writes to other tables (e.g. a CTI base
   * row) atomically. When omitted, the call opens and owns its transaction as
   * before.
   */
  manager?: EntityManager;
}

/**
 * Postgres caps a single statement at 65535 bind parameters (the wire protocol's
 * int16 parameter count). A multi-row INSERT binds roughly `rows × columns`
 * parameters, so the per-chunk row count must satisfy `rows × columns < 65535`.
 * We budget well under that ceiling — the pre-check / hydration SELECTs and the
 * scope / ON CONFLICT clauses add their own (smaller, separate-statement) binds,
 * and leaving headroom keeps us clear of any per-column expansion (arrays, jsonb)
 * TypeORM may emit. 60000 / (widest entity ≈ 60 cols) still clears ~1000 rows.
 */
const MAX_BIND_PARAM_BUDGET = 60000;

/**
 * Default target rows per INSERT chunk when the param budget allows at least this
 * many. Keeps each statement's parameter list and lock-hold time bounded on a
 * multi-million-row import without a statement-per-row round-trip.
 */
const DEFAULT_CHUNK_ROWS = 1000;

/**
 * Rows per INSERT chunk: the smaller of the caller's ceiling (or DEFAULT_CHUNK_ROWS)
 * and the param-budget cap `floor(MAX_BIND_PARAM_BUDGET / columnsPerRow)`, floored
 * at 1 so a single very-wide row still inserts. `columnsPerRow` is the entity's
 * persisted-column count (a safe over-count of the params one row actually binds).
 */
export function computeChunkSize(columnsPerRow: number, requestedMax?: number): number {
  const cols = Math.max(1, columnsPerRow);
  const paramBudgetCap = Math.max(1, Math.floor(MAX_BIND_PARAM_BUDGET / cols));
  const target = requestedMax != null && requestedMax > 0 ? requestedMax : DEFAULT_CHUNK_ROWS;

  return Math.max(1, Math.min(target, paramBudgetCap));
}

/**
 * Chunked multi-row INSERT with an explicit ON CONFLICT clause: the row list is
 * split by {@link computeChunkSize} so no statement exceeds the bind-param
 * budget, and each chunk targets `repository.metadata.target` so STI child
 * repositories emit their discriminator for every row.
 *
 * This is the one canonical copy of the "chunk + insert().onConflict()" loop
 * the CTI/STI bulk writers previously each hand-rolled; a change to the chunk
 * math or the (deprecated) `onConflict` API lands here once.
 */
export async function chunkedConflictInsert<Entity extends ObjectLiteral>(
  repository: Repository<Entity>,
  rows: Entity[],
  onConflict: string,
): Promise<void> {
  const chunkSize = computeChunkSize(repository.metadata.columns.length);
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    await repository
      .createQueryBuilder()
      .insert()
      // Route through `metadata.target` so TS picks the `ObjectLiteral`
      // overload of `.values()`.
      .into(repository.metadata.target)
      .values(rows.slice(offset, offset + chunkSize))
      .onConflict(onConflict)
      .execute();
  }
}

/**
 * Set-based, idempotent batch insert keyed on the provenance triple. Replaces the
 * old per-row `findOne` + `save()` loop (N findOnes + N inserts) with a constant
 * number of statements per batch:
 *
 *   1. One SELECT to find which input rows already exist (the triple is matched
 *      with IS NOT DISTINCT FROM so a NULL source_system equals a NULL
 *      source_system, preserving the prior `findOne({ sourceSystem: x ?? IsNull() })`
 *      semantics). Rows without a (source_type, source_id) are never deduped —
 *      they always insert, exactly like the prior code.
 *   2. One multi-row INSERT ... ON CONFLICT (<triple>) DO NOTHING for the
 *      not-yet-existing rows. ON CONFLICT also absorbs a lost insert race (the
 *      23505 the old catch handled) without throwing. RETURNING yields the primary
 *      keys actually inserted (race losers / intra-batch dups are skipped).
 *      When `conflictUpdateColumns` is supplied the conflict action becomes
 *      `DO UPDATE SET col = EXCLUDED.col, ...` and ALL dedupable rows are sent
 *      (the pre-check is skipped) so existing rows are refreshed; `RETURNING
 *      (xmax = 0) AS inserted` then tells genuine inserts (xmax = 0) apart from
 *      updates so events still fire for new rows only.
 *   3. One SELECT to hydrate every row we return (pre-existing, freshly inserted,
 *      and race losers), so DB-applied defaults / generated columns are present —
 *      matching the prior `repository.save()` round-trip fidelity.
 *
 * Returns one result per input entity, in input order, flagging which rows THIS
 * call inserted so the caller emits a *CreatedEvent per newly-inserted row only
 * (re-ingested/existing rows emit nothing — they were signalled at first insert).
 *
 * The whole call runs in ONE transaction on one connection, so a crash or
 * connection drop mid-call can't leave partially-visible state behind the
 * importer's watermark. Large inputs are split into row-bounded sub-batches
 * (see computeChunkSize) so no single INSERT exceeds the 65535 bind-param limit
 * or holds a table lock over an unbounded VALUES list — but every sub-batch runs
 * inside the SAME transaction, so the call is still all-or-nothing: a failure in
 * any chunk rolls back all of them. Semantics are otherwise unchanged — the ON
 * CONFLICT arbiter still absorbs races from concurrent transactions.
 */
export async function bulkInsertIdempotent<Entity extends ObjectLiteral>(
  options: BulkInsertOptions<Entity>,
): Promise<BulkInsertResult<Entity>[]> {
  if (options.entities.length === 0) {
    return [];
  }

  if (options.manager) {
    return executeBulkInsert({
      ...options,
      repository: options.manager.withRepository(options.repository),
    });
  }

  return options.repository.manager.transaction(async (tx) =>
    executeBulkInsert({ ...options, repository: tx.withRepository(options.repository) }),
  );
}

/**
 * Split the input into row-bounded chunks and run each chunk's statement sequence
 * with a transaction-bound repository. The results are concatenated in input order,
 * so the return contract (one entry per input entity, in order) is preserved across
 * the chunk boundary. All chunks share the outer transaction (this runs inside it),
 * keeping the whole call atomic.
 */
async function executeBulkInsert<Entity extends ObjectLiteral>(
  options: BulkInsertOptions<Entity>,
): Promise<BulkInsertResult<Entity>[]> {
  const { entities, repository } = options;

  const chunkSize = computeChunkSize(repository.metadata.columns.length, options.maxRowsPerChunk);

  // Fast path: a single chunk covers everything — no slicing/concat overhead and
  // identical behaviour to the pre-chunking code for the common (small) batch.
  if (entities.length <= chunkSize) {
    return executeChunk(options, entities);
  }

  const results: BulkInsertResult<Entity>[] = [];
  for (let offset = 0; offset < entities.length; offset += chunkSize) {
    const chunk = entities.slice(offset, offset + chunkSize);
    // Each chunk's own [min, max] time bound is at least as tight as the whole
    // batch's, so hypertable chunk exclusion still holds (see timeColumn doc).
    const chunkResults = await executeChunk(options, chunk);
    for (const result of chunkResults) {
      results.push(result);
    }
  }

  return results;
}

/**
 * The statement sequence (pre-check + INSERT + hydration) for ONE chunk of input
 * entities, run with a repository already bound to the transaction. `chunk` is the
 * slice of `options.entities` this invocation covers; all other options are shared.
 */
async function executeChunk<Entity extends ObjectLiteral>(
  options: BulkInsertOptions<Entity>,
  entities: Entity[],
): Promise<BulkInsertResult<Entity>[]> {
  const {
    repository,
    getTriple,
    primaryKey,
    scope,
    conflictTarget,
    tripleColumns,
    timeColumn,
    conflictUpdateColumns,
  } = options;

  // When refresh columns are requested we DO UPDATE on conflict; otherwise the
  // legacy DO NOTHING find-or-return path is kept exactly as before.
  const doUpdate = (conflictUpdateColumns?.length ?? 0) > 0;

  const meta = repository.metadata;
  const alias = meta.tableName;
  const [typeCol, systemCol, idCol] = tripleColumns;

  // A row is dedupable only when it carries a (source_type, source_id) pair — the
  // partial unique index is `WHERE source_id IS NOT NULL`, and the prior code only
  // looked up the triple when both were present.
  const isDedupable = (triple: SourceTriple): boolean => triple.sourceType != null && triple.sourceId != null;

  const tripleKey = (triple: SourceTriple): string =>
    `${triple.sourceType ?? ''} ${triple.sourceSystem ?? ''} ${triple.sourceId ?? ''}`;

  const applyScope = (qb: SelectQueryBuilder<Entity>): void => {
    for (const [property, value] of Object.entries(scope)) {
      qb.andWhere(`${alias}.${property} = :scope_${property}`, { [`scope_${property}`]: value });
    }
  };

  // Partition-time bound from the batch, for hypertable chunk exclusion (see
  // timeColumn doc). min/max over the input rows' time values.
  const timeBound = ((): { min: unknown; max: unknown } | null => {
    if (!timeColumn) {
      return null;
    }

    let min: unknown;
    let max: unknown;
    for (const entity of entities) {
      const value: unknown = entity[timeColumn];
      if (value == null) {
        continue;
      }

      if (min === undefined || (value as never) < (min as never)) {
        min = value;
      }

      if (max === undefined || (value as never) > (max as never)) {
        max = value;
      }
    }

    return min === undefined ? null : { min, max };
  })();

  const applyTimeBound = (qb: SelectQueryBuilder<Entity>): void => {
    if (timeBound && timeColumn) {
      qb.andWhere(`${alias}.${timeColumn} BETWEEN :bulk_tmin AND :bulk_tmax`, {
        bulk_tmin: timeBound.min,
        bulk_tmax: timeBound.max,
      });
    }
  };

  // OR-list (inside a Brackets) matching the given triples, NULLs-compare-equal
  // on sourceSystem (matching the prior `?? IsNull()` find semantics).
  //
  // This used to emit `col IS NOT DISTINCT FROM :param` for all three columns.
  // That is semantically right but Postgres CANNOT use a btree index — including
  // the partial unique index this very arbiter is named after
  // (browser_activity_source_triple_uniq / content_source_triple_uniq / etc.) —
  // to satisfy an `IS NOT DISTINCT FROM` qual: verified via EXPLAIN ANALYZE, even
  // with `enable_seqscan = off`, Postgres falls back to scanning every row
  // matching the *other* quals (here, just the caller's `scope`, e.g. user_id)
  // and evaluates the OR'd triple match as a row-by-row Filter. On a bulk ingest
  // chunk (up to 1000 triples per call, see DEFAULT_CHUNK_ROWS) against a
  // partially-loaded table this is an O(rows already loaded for that scope)
  // scan PER CHUNK — exactly the "same query, 8s -> 40s+ and climbing as the
  // table fills" symptom from a large bulk sync, despite the correct index
  // existing the whole time.
  //
  // typeCol and idCol are guaranteed NOT NULL for every triple reaching this
  // function (both call sites pre-filter with isDedupable()), so a plain `=` is
  // always correct for them and IS indexable. systemCol is the only column that
  // can legitimately be NULL, so it alone needs the two-armed NULL-safe form
  // (`= :param` when non-null, else a literal `IS NULL` — never bind NULL
  // through `=`, which would never match). With plain `=`, Postgres's OR/IN
  // transformation lets a whole chunk's worth of triples resolve to one Index
  // Scan (confirmed via EXPLAIN ANALYZE: ~1.7s -> ~0.2ms on a 200k-row table).
  // Distinct parameter prefixes keep multiple invocations on one query from
  // colliding.
  const tripleBrackets = (triples: SourceTriple[], prefix: string): Brackets =>
    new Brackets((b: WhereExpressionBuilder) => {
      triples.forEach((triple, i) => {
        const systemParam = `${prefix}_system_${i}`;
        const systemCond =
          triple.sourceSystem == null
            ? `${alias}.${systemCol} IS NULL`
            : `${alias}.${systemCol} = :${systemParam}`;

        b.orWhere(
          `(${alias}.${typeCol} = :${prefix}_type_${i}` +
            ` AND ${systemCond}` +
            ` AND ${alias}.${idCol} = :${prefix}_id_${i})`,
          {
            [`${prefix}_type_${i}`]: triple.sourceType,
            ...(triple.sourceSystem != null ? { [systemParam]: triple.sourceSystem } : {}),
            [`${prefix}_id_${i}`]: triple.sourceId,
          },
        );
      });
    });

  const pkDbName = meta.primaryColumns[0].databaseName;

  // --- 1. Existence pre-check (single SELECT over all dedupable triples). --------
  // DO NOTHING path only: a row already present is skipped from the INSERT (its
  // conflict action is a no-op anyway, so this just trims the VALUES list). Under
  // DO UPDATE we deliberately KEEP existing rows in the INSERT so the conflict
  // action refreshes them, so the pre-check is skipped.
  const existingKeys = new Set<string>();

  if (!doUpdate) {
    const dedupableInputTriples = entities.map(getTriple).filter(isDedupable);
    if (dedupableInputTriples.length > 0) {
      const qb = repository.createQueryBuilder(alias);
      applyScope(qb);
      applyTimeBound(qb);
      qb.andWhere(tripleBrackets(dedupableInputTriples, 'pre'));

      const existing = await qb.getMany();
      for (const row of existing) {
        existingKeys.add(tripleKey(getTriple(row)));
      }
    }
  }

  // Queue rows to send to the INSERT.
  //  - DO NOTHING: drop rows already present (pre-check), keep the rest.
  //  - DO UPDATE: keep all rows, but collapse intra-batch duplicate triples to a
  //    single representative — Postgres rejects an ON CONFLICT DO UPDATE that
  //    would affect the same arbiter row twice in one statement (SQLSTATE 21000),
  //    whereas DO NOTHING silently skips the second. Non-dedupable rows (no
  //    arbiter) always pass through unchanged.
  const seenBatchKeys = new Set<string>();
  const toInsert = entities.filter((entity) => {
    const triple = getTriple(entity);

    if (!isDedupable(triple)) {
      return true;
    }

    const key = tripleKey(triple);
    if (doUpdate) {
      if (seenBatchKeys.has(key)) {
        return false; // intra-batch dup — already represented in the VALUES list
      }

      seenBatchKeys.add(key);

      return true;
    }

    return !existingKeys.has(key);
  });

  // --- 2. Set-based INSERT ... ON CONFLICT (<triple>) DO NOTHING|UPDATE. ---------
  // RETURNING yields the pk plus, under DO UPDATE, `(xmax = 0) AS inserted` so we
  // can tell a genuine insert (xmax = 0 — no prior row version) apart from a row
  // the conflict clause UPDATEd (xmax != 0). DO NOTHING never returns conflicting
  // rows at all, so every returned pk is an insert there.
  const insertedFlagAlias = 'bulk_inserted';
  const insertedPks = new Set<unknown>();

  if (toInsert.length > 0) {
    const conflictAction = doUpdate
      ? `${conflictTarget} DO UPDATE SET ${conflictUpdateColumns!
          .map((col) => `"${col}" = EXCLUDED."${col}"`)
          .join(', ')}`
      : `${conflictTarget} DO NOTHING`;

    const insertQb = repository
      .createQueryBuilder()
      .insert()
      .into(meta.target)
      .values(toInsert)
      // Deprecated but the only API that emits an explicit ON CONFLICT target;
      // `orIgnore()` would emit a bare untargeted DO NOTHING (which also swallows
      // PK conflicts). We want to target exactly the provenance unique index.
      .onConflict(conflictAction);

    // Under DO UPDATE every conflicting row is returned, so RETURNING must carry
    // the xmax-derived inserted flag to distinguish inserts from refreshes.
    insertQb.returning(doUpdate ? `${pkDbName}, (xmax = 0) AS ${insertedFlagAlias}` : [pkDbName]);

    const insertResult = await insertQb.execute();

    for (const raw of (insertResult.raw as Record<string, unknown>[]) ?? []) {
      // DO NOTHING: every returned row was inserted. DO UPDATE: only xmax = 0 was.
      if (!doUpdate || raw[insertedFlagAlias] === true) {
        insertedPks.add(raw[pkDbName]);
      }
    }
  }

  // --- 3. Hydrate every row we return: dedupable rows by triple + any rows we
  // inserted by pk (covers non-dedupable inserts). One SELECT. -------------------
  const hydratedByKey = new Map<string, Entity>();
  const hydratedByPk = new Map<unknown, Entity>();

  const returnDedupableTriples = entities.map(getTriple).filter(isDedupable);
  const insertedPkList = [...insertedPks];

  if (returnDedupableTriples.length > 0 || insertedPkList.length > 0) {
    const qb = repository.createQueryBuilder(alias);
    applyScope(qb);
    applyTimeBound(qb);
    qb.andWhere(
      new Brackets((outer: WhereExpressionBuilder) => {
        if (returnDedupableTriples.length > 0) {
          outer.orWhere(tripleBrackets(returnDedupableTriples, 'post'));
        }

        if (insertedPkList.length > 0) {
          outer.orWhere(`${alias}.${primaryKey} IN (:...bulk_pks)`, { bulk_pks: insertedPkList });
        }
      }),
    );

    const rows = await qb.getMany();
    for (const row of rows) {
      const triple = getTriple(row);
      if (isDedupable(triple)) {
        hydratedByKey.set(tripleKey(triple), row);
      }

      hydratedByPk.set(row[primaryKey], row);
    }
  }

  // --- Reassemble in input order, flagging which rows this call inserted. --------
  // Non-dedupable inserts are consumed positionally against the queued order.
  const nonDedupableInsertedPks = toInsert
    .filter((entity) => !isDedupable(getTriple(entity)))
    .map((entity) => entity[primaryKey]);
  let nonDedupableCursor = 0;

  // An intra-batch duplicate triple maps two input rows to one inserted DB row;
  // flag only the first as `inserted` so the caller emits a single *CreatedEvent
  // for it (mirrors the old loop, where the duplicate lost the race + re-fetched).
  const flaggedInsertedPks = new Set<unknown>();

  return entities.map((entity) => {
    const triple = getTriple(entity);

    if (!isDedupable(triple)) {
      // Non-dedupable rows always insert (source_id IS NULL is outside the partial
      // index, so ON CONFLICT can't skip them). Consume the next queued pk.
      const pk = nonDedupableInsertedPks[nonDedupableCursor++];
      const hydrated = pk != null ? hydratedByPk.get(pk) : undefined;

      return { entity: hydrated ?? entity, inserted: true };
    }

    const key = tripleKey(triple);
    const hydrated = hydratedByKey.get(key) ?? entity;
    const pk = hydrated[primaryKey];

    const inserted = pk != null && insertedPks.has(pk) && !flaggedInsertedPks.has(pk);
    if (inserted) {
      flaggedInsertedPks.add(pk);
    }

    return { entity: hydrated, inserted };
  });
}
