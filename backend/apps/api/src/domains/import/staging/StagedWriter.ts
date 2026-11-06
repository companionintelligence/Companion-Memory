import { createHash } from 'node:crypto';

import type { EntityManager } from 'typeorm';

import type { Entity, Graph, ImportPipeline, Item, Metadata } from '../datasources/timeline';

import { digestFile, type ContentDigest } from './contentDigest';
import {
  dateToIso,
  declaredAccumulate,
  entityIdentityKey,
  entityKey,
  hashItem,
  legacyEntityIdentityKey,
  mergeAccumulatedMetadata,
  needsContentDigest,
  resolveEntityType,
  withContactIdentifiers,
} from './identity';
import { stripNulCharacters } from './stripNulCharacters';

/**
 * The `drops` slug for an item swallowed by the within-run unique index whose
 * identity we could NOT prove was the same thing.
 *
 * Distinct from `itemsDeduped`, which is the honest, expected collapse — one
 * photo replicated across three albums. This slug is the other kind: two
 * records that hashed alike arriving from different places, with nothing to
 * confirm they are one record. That was previously indistinguishable from a
 * legitimate dedup, so a file that vanished left no trace beyond a counter.
 */
export const COLLAPSED_DISTINCT_PATH = 'collapsed-distinct-path';

/** Digests computed for one batch, keyed by the item object the parser emitted. */
type BatchDigests = Map<Item, ContentDigest>;

/** An already-staged entity, as a repeat sighting reads it back to grow it. */
interface StoredEntityRow {
  id: string;
  metadata: Record<string, unknown>;
  accumulate: string[] | null;
}

/** What one run's staging produced. Folded into the parse stage's `detail`. */
export interface StagedCounts {
  items: number;
  itemsDeduped: number;
  entities: number;
  entitiesGrown: number;
  relationships: number;
  /** Records the parsers deliberately discarded, by their stable reason slug. */
  drops: Record<string, number>;
  /**
   * Records a gate would have discarded and the parser deliberately RESCUED, by
   * reason slug (today only `receipt_kept_from_bulk`). The counterpart of
   * {@link StagedCounts.drops}, and deliberately not merged into it: these rows
   * landed, so counting them as drops would report a rescue as a loss.
   */
  keeps: Record<string, number>;
  /**
   * What a parser reported via {@link ImportPipeline.consumed} it actually
   * read, summed across every call. `undefined` — not `0` — when no parser
   * called it at all, so `ParseStage` can tell "never reported" apart from
   * "reported zero" and fall back to the derived floor (`produced + dropped`)
   * only in the first case.
   */
  recordsRead?: number;
}

/** Graphs buffered before a flush. Bounded so a 40GB parse is observable, not one commit at the end. */
export const DEFAULT_FLUSH_THRESHOLD = 500;

/**
 * The `ImportPipeline` the datasource parsers push into.
 *
 * The parsers call `push(graph)` SYNCHRONOUSLY — that is their contract and it
 * predates this port — while every write here is asynchronous. So pushes buffer
 * and the stage runner flushes: at the threshold, and once more at the end.
 * Batching is also what keeps the parse phase observable, since a run that
 * committed everything in one transaction at the end would show no progress for
 * forty minutes and then finish instantly.
 *
 * ## What collapses, and what deliberately does not
 *
 * WITHIN one run, items collapse on `(run_id, data_source, content_hash)` and
 * entities on `(run_id, identity_key)`. That is a parser contract, not an
 * optimisation: a photo library replicates one file into every album folder it
 * belongs to, and one person appears in a mailbox under three spellings.
 *
 * ACROSS runs and sources, nothing collapses here. `ci.*` owns that — content
 * hashing, identifier claims, entity resolution — and re-implementing any of it
 * in staging is how the two would drift apart. The same photo arriving from
 * Google Photos and from an iCloud dump is two honest staged rows.
 */
export class StagedWriter implements ImportPipeline {
  private readonly buffer: Graph[] = [];

  private readonly counts: StagedCounts = {
    items: 0,
    itemsDeduped: 0,
    entities: 0,
    entitiesGrown: 0,
    relationships: 0,
    drops: {},
    keeps: {},
  };

  /**
   * A CACHE of handle-less entities seen by THIS attempt, keyed by
   * {@link entityKey}, saving a round trip on a repeat sighting.
   *
   * It is no longer the dedup. Entities with a handle collapse on
   * `(run_id, identity_key)`; handle-less ones cannot share that index — they
   * would all collide on NULL — so they collapse on `(run_id, dedupe_key)`
   * instead. Holding the dedup here was the bug: a StagedWriter is constructed
   * per parse ATTEMPT, so a resume after a crash began with an empty map and
   * re-inserted everything the dead attempt had already written (2,000
   * duplicate entities and 2,000 spurious edges on a 20k-card run).
   */
  private readonly handleless = new Map<string, string>();

  /** Serializes scheduled flushes so batches land in the order they were pushed. */
  private chain: Promise<void> = Promise.resolve();

  /**
   * The first flush error, held until {@link settled} can throw it.
   *
   * `scheduleFlush` is called from `push`, which is synchronous and has nowhere
   * to put an error — so the chain used to be left rejected until `settled`
   * awaited it. Between those two moments nothing was observing it, and a parse
   * is a long single `await fileImport(...)`: Node saw an unhandled rejection
   * and the process-level handler in `application.ts` exited the WORKER. One
   * bad row took down every import on the appliance, and the staleness sweep
   * then re-queued the stage into a crash loop.
   *
   * It is reachable from parser data, not just infrastructure: several location
   * parsers validate coordinates with `isNaN` only, while `staged_items` has
   * CHECK constraints on latitude/longitude — so a malformed GPX is enough.
   *
   * Captured rather than rethrown so the chain always settles, and re-raised at
   * `settled()`, which is where the contract always said it should surface.
   */
  private failure: Error | null = null;

  constructor(
    private readonly manager: EntityManager,
    private readonly scope: { userId: string; runId: string; dataSource: string },
    private readonly flushThreshold: number = DEFAULT_FLUSH_THRESHOLD,
  ) {}

  /**
   * Buffer a graph. Synchronous, because that is what the parsers expect.
   *
   * A parser runs as ONE `await fileImport(...)` call, so the runner never gets
   * a turn to flush in the middle of a mailbox. Reaching the threshold therefore
   * schedules a flush here, onto a serial chain — writes stay in order, memory
   * stays near one batch in the common case, and the runner awaits the chain
   * through {@link settled} when the parser returns.
   *
   * The bound is soft: nothing can block a synchronous function, so a parser
   * that emits faster than Postgres accepts will still grow the chain. That is
   * upstream's memory profile in the worst case and better than it in every
   * other, which is the trade this shape is making.
   */
  push(graph: Graph): void {
    // U+0000 is legal in the exports but not in Postgres text/jsonb; one
    // NUL-bearing record used to fail its batch and every batch after it.
    this.buffer.push(stripNulCharacters(graph));

    if (this.buffer.length >= this.flushThreshold) {
      this.scheduleFlush();
    }
  }

  /** Queue a flush behind whatever is already draining. Never rejects the caller. */
  private scheduleFlush(): void {
    const batch = this.buffer.splice(0, this.buffer.length);

    this.chain = this.chain
      .then(async () => {
        // Once one batch has failed the parse is going to fail at `settled`;
        // writing the rest would only add rows to a run that is about to be
        // reported as broken, and would compound one bad record into many.
        if (this.failure != null) {
          return;
        }

        await this.writeBatch(batch);
      })
      .catch((err: unknown) => {
        this.failure ??= err instanceof Error ? err : new Error(String(err));
      });
  }

  /**
   * Wait for every scheduled flush, then write whatever is left.
   *
   * A rejection surfaces HERE rather than at the `push` that caused it — a
   * synchronous push has nowhere to put an error, and swallowing one would let a
   * parse report success over rows that never landed.
   */
  async settled(): Promise<void> {
    await this.chain;

    if (this.failure != null) {
      throw this.failure;
    }

    await this.flush();
  }

  /**
   * Record a dropped record. Purely a reporting hook — the parse continues —
   * but it is what turns silent data loss into a number on the stage detail.
   *
   * The parsers' optional second argument (a free-text detail) is deliberately
   * not retained: it is per-record, so keeping it would grow the stage detail
   * with the size of the import, and the stable `reason` slug is what makes the
   * ledger comparable between runs. Callers still pass it; the narrower
   * signature satisfies the `ImportPipeline` contract.
   */
  drop(reason: string): void {
    this.counts.drops[reason] = (this.counts.drops[reason] ?? 0) + 1;
  }

  /**
   * Record a rescue: a record some gate would have discarded and the parser
   * kept anyway. Reporting only — the row is staged through {@link push} like
   * any other.
   *
   * A separate counter from {@link drop} on purpose. Gmail's receipt discovery
   * keeps order confirmations the bulk filter rejects, and the first version of
   * that change counted them as `bulk_filtered` drops — so the run report said
   * a record was lost at the exact moment it was saved.
   */
  keep(reason: string): void {
    this.counts.keeps[reason] = (this.counts.keeps[reason] ?? 0) + 1;
  }

  /**
   * Record N records the parser actually read, summed across every call this
   * attempt — see {@link ImportPipeline.consumed}. Purely additive: a parser
   * that never calls this leaves {@link StagedCounts.recordsRead} `undefined`.
   */
  consumed(n: number): void {
    this.counts.recordsRead = (this.counts.recordsRead ?? 0) + n;
  }

  /** True when the buffer has reached the point where the runner should flush. */
  get shouldFlush(): boolean {
    return this.buffer.length >= this.flushThreshold;
  }

  get pending(): number {
    return this.buffer.length;
  }

  /** A snapshot of what has been written so far. */
  get totals(): StagedCounts {
    return { ...this.counts, drops: { ...this.counts.drops }, keeps: { ...this.counts.keeps } };
  }

  /**
   * Write everything buffered.
   *
   * One transaction per flush. A killed worker therefore loses at most one
   * batch, and loses it cleanly — a half-written graph whose item landed but
   * whose edges did not would stage a record with no participants, which reads
   * downstream as a message from nobody.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    await this.writeBatch(this.buffer.splice(0, this.buffer.length));
  }

  private async writeBatch(batch: Graph[]): Promise<void> {
    if (batch.length === 0) {
      return;
    }

    // BEFORE the transaction opens. Fingerprinting reads files off disk, and
    // holding a Postgres transaction open across that would pin a pooled
    // connection for the length of the slowest read in the batch.
    const digests = await this.digestBatch(batch);
    const plan = this.planBatch(batch, digests);

    // Three set-based statements per flush, not three per record. The first
    // shape of this writer ran one single-row INSERT per item, per entity on
    // every edge (and a SELECT read-back plus a possible UPDATE on each
    // conflict), and one per relationship — all awaited in series inside the
    // transaction, ~8-12 round trips for one message with a sender, two
    // recipients and an owner. Over a 700k-row import that was millions of
    // sequential round trips with the connection pinned throughout.
    //
    // The within-batch collapse now happens in memory first (planBatch), so the
    // statements below never carry two rows for one key; the ON CONFLICT
    // clauses only ever meet rows an EARLIER flush or attempt wrote.
    await this.manager.transaction(async (tx) => {
      const itemIds = await this.writeItems(tx, plan.items);
      const entityIds = await this.writeEntities(tx, plan.entities);

      await this.writeRelationships(tx, plan.relationships, itemIds, entityIds);
    });
  }

  /**
   * Fingerprint the items in this batch whose identity would otherwise
   * degenerate to their basename.
   *
   * Only those — see {@link needsContentDigest}. An export is mostly records
   * that already carry a parser id or a timestamp, and reading all 12GB of a
   * Takeout to learn what a Gmail message id already says would multiply the
   * cost of every import to fix a fault that touches a fraction of it.
   *
   * Sequential, because these reads are disk-bound on the same volume the
   * parser is already walking and the parse is what the user is waiting on.
   */
  private async digestBatch(batch: Graph[]): Promise<BatchDigests> {
    const digests: BatchDigests = new Map();

    for (const item of collectItems(batch)) {
      if (digests.has(item) || !needsContentDigest(item) || !item.intermediateLocation) {
        continue;
      }

      const digest = await digestFile(item.intermediateLocation);

      if (digest != null) {
        digests.set(item, digest);
      }
    }

    return digests;
  }

  /**
   * Resolve one batch to the rows it will write, collapsing repeats in memory.
   *
   * Pure: no I/O, no counters. Items key on `(data_source, content_hash)`,
   * identity-keyed entities on `identity_key`, handle-less ones on the sha256 of
   * {@link entityKey} — the same three keys the partial unique indexes enforce,
   * so what collapses here is exactly what Postgres would have collapsed one
   * row at a time. The FIRST sighting of a key is the row; every later sighting
   * is a repeat, which for an item is a dedup to count and for an entity is a
   * growth to merge (see writeEntities).
   *
   * Walk order is the push order: a graph's item, then its entity, then each
   * edge's far side (item or entity), then the owner — the order the single-row
   * writer took, so first-sighting-wins resolves the same way it always did.
   */
  private planBatch(batch: Graph[], digests: BatchDigests): BatchPlan {
    const items = new Map<string, PlannedItem>();
    const entities = new Map<string, PlannedEntity>();
    const relationships: PlannedRelationship[] = [];
    const seenRelationships = new Set<string>();

    const planItem = (item: Item): string => {
      const dataSource = item.dataSource ?? this.scope.dataSource;
      const digest = digests.get(item) ?? null;
      const contentHash = hashItem(item, dataSource, digest?.sha256);
      const key = `${dataSource}\u0000${contentHash}`;
      const planned = items.get(key);

      if (planned) {
        planned.repeats.push({ item, digest });
      } else {
        items.set(key, { key, dataSource, contentHash, item, digest, repeats: [] });
      }

      return key;
    };

    const planEntity = (parsed: Entity): string => {
      // Every email and phone a contact states, recorded while the parser's
      // attributes still exist — after this write only `identity_key`, the ONE
      // smallest handle, survives. See contactIdentifiers in ./identity.
      const entity = withContactIdentifiers(parsed);
      const identityKey = entityIdentityKey(entity);
      let key: string;
      let kind: PlannedEntity['kind'];
      let cacheKey: string | null = null;

      if (identityKey != null) {
        kind = 'identity';
        key = `identity\u0000${identityKey}`;
      } else {
        kind = 'handleless';
        cacheKey = entityKey(entity);
        key = `handleless\u0000${cacheKey}`;
      }

      const planned = entities.get(key);

      if (planned) {
        planned.repeats.push(entity);
      } else {
        // The key the rule before shared handles and phone extensions were
        // passed over gave this entity (legacyEntityIdentityKey), kept only where
        // it differs: an existing `ci.entities` row was minted under it, and the
        // push moves that row onto the new key rather than minting a second one.
        // On a conflict the FIRST card's legacy key stands, like its name does.
        const legacy = legacyEntityIdentityKey(entity);

        entities.set(key, {
          key,
          kind,
          identityKey,
          // Hashed because `entityKey` embeds the attribute JSON and has no
          // length bound, while a btree index entry does.
          dedupeKey: cacheKey == null ? null : createHash('sha256').update(cacheKey).digest('hex'),
          cacheKey,
          first: entity,
          type: resolveEntityType(entity),
          legacyIdentityKey: legacy !== identityKey ? legacy : null,
          repeats: [],
        });
      }

      return key;
    };

    const planRelationship = (
      itemKey: string,
      relation: string | null,
      metadata: Metadata | undefined,
      target: { entityKey: string | null; relatedItemKey: string | null },
    ): void => {
      if (target.entityKey == null && target.relatedItemKey == null) {
        return;
      }

      // The two partial unique indexes treat NULL relations as equal (NULLS NOT
      // DISTINCT), so a null relation is one value here too.
      const dedupe = `${itemKey}\u0001${target.entityKey ?? ''}\u0001${target.relatedItemKey ?? ''}\u0001${
        relation ?? '\u0000'
      }`;

      if (seenRelationships.has(dedupe)) {
        return;
      }

      seenRelationships.add(dedupe);
      relationships.push({ itemKey, relation, metadata, ...target });
    };

    for (const graph of batch) {
      const itemKey = graph.item ? planItem(graph.item) : null;

      if (graph.entity) {
        planEntity(graph.entity);
      }

      for (const edge of graph.edges ?? []) {
        // An edge hangs off an item. A graph that carried only an entity has
        // nothing for its edges to attach to, and inventing an item to hold them
        // would stage a record the export never contained.
        if (itemKey == null) {
          continue;
        }

        const targetItemKey = edge.to.item ? planItem(edge.to.item) : null;
        const targetEntityKey = edge.to.entity ? planEntity(edge.to.entity) : null;

        planRelationship(itemKey, edge.relation, edge.metadata, {
          entityKey: targetEntityKey,
          relatedItemKey: targetEntityKey == null ? targetItemKey : null,
        });
      }

      // The owner is a participant like any other, expressed as an edge so the
      // push has one shape to read rather than a special case.
      if (itemKey != null && graph.item?.owner) {
        planRelationship(itemKey, 'owner', undefined, {
          entityKey: planEntity(graph.item.owner),
          relatedItemKey: null,
        });
      }
    }

    return { items: [...items.values()], entities: [...entities.values()], relationships };
  }

  /**
   * One INSERT for every distinct item in the batch, then one SELECT for the
   * ones the run already had. Returns the staged id for every planned key.
   *
   * `jsonb_to_recordset` carries the rows as a single parameter, so a batch of
   * any width is one statement with one bind; each row's `ord` (`ORDER BY t.ord`)
   * keeps insertion in push order, which is what `ORDER BY id` on the uuid v7
   * primary key means to every later stage.
   */
  private async writeItems(tx: EntityManager, planned: PlannedItem[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();

    if (planned.length === 0) {
      return ids;
    }

    const rows = planned.map((entry, ord) => ({
      ord,
      run_id: this.scope.runId,
      user_id: this.scope.userId,
      data_source: entry.dataSource,
      classification: entry.item.classification ?? null,
      content_hash: entry.contentHash,
      // dateToIso rejects an Invalid Date (NaN getTime()) rather than letting
      // it reach the timestamptz cast -- hashItem already applies this same
      // normalization to these fields, this reuses it at the actual insert site.
      occurred_at: dateToIso(entry.item.timestamp),
      timespan_end: dateToIso(entry.item.timespanEnd),
      latitude: entry.item.location?.latitude ?? null,
      longitude: entry.item.location?.longitude ?? null,
      filename: entry.item.content?.filename ?? null,
      media_type: entry.item.content?.mediaType ?? null,
      original_location: entry.item.originalLocation ?? null,
      intermediate_location: entry.item.intermediateLocation ?? null,
      metadata: entry.item.metadata ?? {},
      content_sha256: entry.digest?.sha256 ?? null,
      size_bytes: entry.digest?.sizeBytes ?? null,
    }));

    const inserted = await tx.query<Array<{ id: string; data_source: string; content_hash: string }>>(
      `INSERT INTO ci_import.staged_items
         (run_id, user_id, data_source, classification, content_hash, occurred_at, timespan_end,
          latitude, longitude, filename, media_type, original_location, intermediate_location, metadata,
          content_sha256, size_bytes)
       SELECT t.run_id, t.user_id, t.data_source, t.classification, t.content_hash, t.occurred_at,
              t.timespan_end, t.latitude, t.longitude, t.filename, t.media_type, t.original_location,
              t.intermediate_location, t.metadata, t.content_sha256, t.size_bytes
         FROM jsonb_to_recordset($1::jsonb) AS t(
                run_id uuid, user_id uuid, data_source text, classification text, content_hash text,
                occurred_at timestamptz, timespan_end timestamptz, latitude double precision,
                longitude double precision, filename text, media_type text, original_location text,
                intermediate_location text, metadata jsonb, content_sha256 text, size_bytes bigint,
                ord bigint)
        ORDER BY t.ord
       ON CONFLICT (run_id, data_source, content_hash) DO NOTHING
       RETURNING id, data_source, content_hash`,
      [JSON.stringify(rows)],
    );

    const insertedKeys = new Set<string>();

    for (const row of inserted) {
      const key = `${row.data_source}\u0000${row.content_hash}`;

      ids.set(key, row.id);
      insertedKeys.add(key);
    }

    this.counts.items += inserted.length;

    // `DO NOTHING` returns nothing on conflict, so the duplicates are read back
    // in one go. This is the album-replicated photo collapsing, and it is counted
    // rather than silently swallowed — "we staged 4,000 of your 12,000 photo
    // files" is a question people ask.
    const missed = planned.filter((entry) => !insertedKeys.has(entry.key));
    const existingByKey = new Map<string, ExistingItemRow>();

    if (missed.length > 0) {
      const existing = await tx.query<ExistingItemRow[]>(
        `SELECT id, data_source, content_hash, intermediate_location, content_sha256
           FROM ci_import.staged_items
          WHERE run_id = $1::uuid
            AND (data_source, content_hash) IN (
                  SELECT data_source, content_hash
                    FROM jsonb_to_recordset($2::jsonb) AS k(data_source text, content_hash text))`,
        [
          this.scope.runId,
          JSON.stringify(
            missed.map((entry) => ({ data_source: entry.dataSource, content_hash: entry.contentHash })),
          ),
        ],
      );

      for (const row of existing) {
        existingByKey.set(`${row.data_source}\u0000${row.content_hash}`, row);
      }
    }

    for (const entry of planned) {
      const existing = existingByKey.get(entry.key);

      if (!insertedKeys.has(entry.key)) {
        if (existing == null) {
          throw new Error('staged item conflicted on its content hash but could not be read back');
        }

        ids.set(entry.key, existing.id);
        this.counts.itemsDeduped += 1;
        this.recordCollapse(entry.item, entry.digest, existing);
      }

      // A repeat within the batch collapsed onto the first sighting — or, when
      // the first sighting itself conflicted, onto the row an earlier flush
      // wrote, which is what its read-back would have shown it.
      const collapsedOnto: ExistingLike = existing ?? {
        intermediate_location: entry.item.intermediateLocation ?? null,
        content_sha256: entry.digest?.sha256 ?? null,
      };

      for (const repeat of entry.repeats) {
        this.counts.itemsDeduped += 1;
        this.recordCollapse(repeat.item, repeat.digest, collapsedOnto);
      }
    }

    return ids;
  }

  /**
   * Tell a legitimate collapse apart from a swallowed record, and put the
   * second in the drop ledger.
   *
   * A collapse is PROVEN when the two rows carry the same content digest, or
   * when they came from the same place — the album-replicated photo, a parser
   * re-emitting one record. What is left is two records from different paths
   * that we could not show are the same thing: something was consumed by the
   * rename and deleted with the run's scratch tree, and until now the only
   * evidence was an `itemsDeduped` tick indistinguishable from the honest case.
   *
   * Reported, not refused. Staging a second row would violate the within-run
   * unique index the dedup depends on, and the parse continuing is the whole
   * contract of the drop ledger — what changes is that the loss is now a
   * number someone can see.
   */
  private recordCollapse(
    item: Item,
    digest: ContentDigest | null,
    existing: { intermediate_location: string | null; content_sha256: string | null } | undefined,
  ): void {
    if (existing == null) {
      return;
    }

    if (digest != null && existing.content_sha256 === digest.sha256) {
      return;
    }

    if ((existing.intermediate_location ?? null) === (item.intermediateLocation ?? null)) {
      return;
    }

    this.drop(COLLAPSED_DISTINCT_PATH);
  }

  /**
   * One INSERT per entity path (identity-keyed, handle-less), one read-back of
   * the rows the run already had, then one UPDATE for every row this batch
   * grew. Returns the staged id for every planned key.
   *
   * Growth is sequential per key, in sighting order, exactly as the single-row
   * writer's read-merge-write loop was: a row an earlier flush wrote starts from
   * its stored metadata and takes every sighting in this batch; a row this
   * batch inserted starts from its first sighting and takes the rest.
   * `graph_dirty` is set alongside, because the push resumes from a high-water
   * mark: a row that changed after it was already sent would otherwise never be
   * revisited. So is the union of the sightings' `accumulate` lists, since the
   * keys this batch grew must be unioned — not replaced — at push time too.
   */
  private async writeEntities(tx: EntityManager, planned: PlannedEntity[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();

    if (planned.length === 0) {
      return ids;
    }

    const identityKeyed = planned.filter((entry) => entry.kind === 'identity');
    // Handle-less entities with a handle cannot share the identity index — they
    // would all collide on NULL — so they collapse on `(run_id, dedupe_key)`.
    // The in-process map is a cache in front of that index, not the dedup
    // itself: a StagedWriter is constructed per parse ATTEMPT, so a resume after
    // a crash starts with an empty map and — before the index — simply
    // re-inserted everything the dead attempt had already written.
    const handleless = planned.filter((entry) => entry.kind === 'handleless');
    const cached = handleless.filter((entry) => this.handleless.has(entry.cacheKey!));
    const uncached = handleless.filter((entry) => !this.handleless.has(entry.cacheKey!));

    const insertRows = (entries: PlannedEntity[]) =>
      entries.map((entry, ord) => ({
        ord,
        run_id: this.scope.runId,
        user_id: this.scope.userId,
        type: entry.type,
        name: entry.first.name ?? null,
        metadata: entry.first.metadata ?? {},
        identity_key: entry.identityKey,
        data_source: this.scope.dataSource,
        dedupe_key: entry.dedupeKey,
        legacy_identity_key: entry.legacyIdentityKey,
        accumulate: declaredAccumulate(entry.first),
      }));

    const insertSql = (conflict: string, returning: string) =>
      `INSERT INTO ci_import.staged_entities
         (run_id, user_id, type, name, metadata, identity_key, data_source, dedupe_key, legacy_identity_key, accumulate)
       SELECT t.run_id, t.user_id, t.type, t.name, t.metadata, t.identity_key, t.data_source, t.dedupe_key,
              t.legacy_identity_key, t.accumulate
         FROM jsonb_to_recordset($1::jsonb) AS t(
                run_id uuid, user_id uuid, type text, name text, metadata jsonb, identity_key text,
                data_source text, dedupe_key text, legacy_identity_key text, accumulate text[], ord bigint)
        ORDER BY t.ord
       ON CONFLICT ${conflict} DO NOTHING
       RETURNING id, ${returning}`;

    const insertedKeys = new Set<string>();
    // Rows that must be read back: a stored row to grow onto, or an insert that
    // conflicted with an earlier flush or attempt.
    const existingByKey = new Map<string, StoredEntityRow>();

    if (identityKeyed.length > 0) {
      const inserted = await tx.query<Array<{ id: string; identity_key: string }>>(
        insertSql('(run_id, identity_key) WHERE identity_key IS NOT NULL', 'identity_key'),
        [JSON.stringify(insertRows(identityKeyed))],
      );

      for (const row of inserted) {
        const key = `identity\u0000${row.identity_key}`;

        ids.set(key, row.id);
        insertedKeys.add(key);
      }

      const missed = identityKeyed.filter((entry) => !insertedKeys.has(entry.key));

      if (missed.length > 0) {
        const existing = await tx.query<Array<StoredEntityRow & { identity_key: string }>>(
          `SELECT id, metadata, accumulate, identity_key FROM ci_import.staged_entities
            WHERE run_id = $1::uuid AND identity_key = ANY($2::text[])`,
          [this.scope.runId, missed.map((entry) => entry.identityKey)],
        );

        for (const row of existing) {
          existingByKey.set(`identity\u0000${row.identity_key}`, row);
        }
      }
    }

    if (uncached.length > 0) {
      const inserted = await tx.query<Array<{ id: string; dedupe_key: string }>>(
        insertSql('(run_id, dedupe_key) WHERE dedupe_key IS NOT NULL', 'dedupe_key'),
        [JSON.stringify(insertRows(uncached))],
      );
      const byDedupeKey = new Map(uncached.map((entry) => [entry.dedupeKey!, entry]));

      for (const row of inserted) {
        const entry = byDedupeKey.get(row.dedupe_key)!;

        ids.set(entry.key, row.id);
        insertedKeys.add(entry.key);
      }

      // A previous attempt wrote it. Read it back and accumulate onto it, exactly
      // as a repeat sighting within one attempt would — the resumed parse is
      // replaying records the dead one had already seen, and treating them as
      // new is what produced the duplicate edges alongside the duplicate rows.
      const missed = uncached.filter((entry) => !insertedKeys.has(entry.key));

      if (missed.length > 0) {
        const existing = await tx.query<Array<StoredEntityRow & { dedupe_key: string }>>(
          `SELECT id, metadata, accumulate, dedupe_key FROM ci_import.staged_entities
            WHERE run_id = $1::uuid AND dedupe_key = ANY($2::text[])`,
          [this.scope.runId, missed.map((entry) => entry.dedupeKey)],
        );

        for (const row of existing) {
          existingByKey.set(byDedupeKey.get(row.dedupe_key)!.key, row);
        }
      }
    }

    if (cached.length > 0) {
      // A recurring handle-less entity still accumulates. Dishes are the whole
      // reason: an Uber Eats croissant has no phone number, so it takes this
      // path, and its price on a second morning is a fact the first sighting
      // cannot carry. Growing only the identity-keyed path silently dropped
      // every one of them.
      const byId = new Map(cached.map((entry) => [this.handleless.get(entry.cacheKey!)!, entry]));
      const existing = await tx.query<StoredEntityRow[]>(
        `SELECT id, metadata, accumulate FROM ci_import.staged_entities WHERE id = ANY($1::uuid[])`,
        [[...byId.keys()]],
      );

      for (const row of existing) {
        existingByKey.set(byId.get(row.id)!.key, row);
      }

      for (const [id, entry] of byId) {
        existingByKey.set(entry.key, existingByKey.get(entry.key) ?? { id, metadata: {}, accumulate: null });
      }
    }

    const grown: Array<{ id: string; metadata: Record<string, unknown>; accumulate: string[] | null }> = [];

    for (const entry of planned) {
      const inserted = insertedKeys.has(entry.key);
      const existing = existingByKey.get(entry.key);

      if (inserted) {
        this.counts.entities += 1;
      } else {
        if (existing == null) {
          throw new Error(
            entry.kind === 'identity'
              ? 'staged entity conflicted on its identity key but could not be read back'
              : 'staged entity conflicted on its dedupe key but could not be read back',
          );
        }

        ids.set(entry.key, existing.id);
      }

      if (entry.cacheKey != null) {
        this.handleless.set(entry.cacheKey, ids.get(entry.key)!);
      }

      let current: { metadata: Record<string, unknown>; accumulate: string[] | null } = inserted
        ? { metadata: entry.first.metadata ?? {}, accumulate: declaredAccumulate(entry.first) }
        : { metadata: existing!.metadata ?? {}, accumulate: existing!.accumulate };
      let dirty = false;

      for (const sighting of inserted ? entry.repeats : [entry.first, ...entry.repeats]) {
        const merged = mergeAccumulatedMetadata(current.metadata, sighting);

        if (merged == null) {
          continue;
        }

        current = { metadata: merged, accumulate: declaredAccumulate(sighting, current.accumulate) };
        dirty = true;
        this.counts.entitiesGrown += 1;
      }

      if (dirty) {
        grown.push({ id: ids.get(entry.key)!, ...current });
      }
    }

    if (grown.length > 0) {
      await tx.query(
        `UPDATE ci_import.staged_entities AS s
            SET metadata = t.metadata, graph_dirty = true, accumulate = t.accumulate
           FROM jsonb_to_recordset($1::jsonb) AS t(id uuid, metadata jsonb, accumulate text[])
          WHERE s.id = t.id`,
        [JSON.stringify(grown)],
      );
    }

    return ids;
  }

  /**
   * One INSERT per target kind. Two partial unique indexes rather than one over
   * both target columns, so the ON CONFLICT target has to name the one that
   * applies — a combined index would read every item→item row as
   * (item_id, NULL, relation) and collapse edges pointing at different items.
   */
  private async writeRelationships(
    tx: EntityManager,
    planned: PlannedRelationship[],
    itemIds: Map<string, string>,
    entityIds: Map<string, string>,
  ): Promise<void> {
    const rows = planned.map((edge, ord) => ({
      ord,
      run_id: this.scope.runId,
      item_id: itemIds.get(edge.itemKey)!,
      entity_id: edge.entityKey == null ? null : entityIds.get(edge.entityKey)!,
      related_item_id: edge.relatedItemKey == null ? null : itemIds.get(edge.relatedItemKey)!,
      relation: edge.relation,
      metadata: edge.metadata ?? {},
    }));

    const targets: Array<{ rows: typeof rows; conflict: string }> = [
      {
        rows: rows.filter((row) => row.entity_id != null),
        conflict: '(item_id, entity_id, relation) WHERE entity_id IS NOT NULL',
      },
      {
        rows: rows.filter((row) => row.entity_id == null),
        conflict: '(item_id, related_item_id, relation) WHERE related_item_id IS NOT NULL',
      },
    ];

    for (const target of targets) {
      if (target.rows.length === 0) {
        continue;
      }

      const inserted = await tx.query<unknown[]>(
        `INSERT INTO ci_import.staged_relationships
           (run_id, item_id, entity_id, related_item_id, relation, metadata)
         SELECT t.run_id, t.item_id, t.entity_id, t.related_item_id, t.relation, t.metadata
           FROM jsonb_to_recordset($1::jsonb) AS t(
                  run_id uuid, item_id uuid, entity_id uuid, related_item_id uuid, relation text,
                  metadata jsonb, ord bigint)
          ORDER BY t.ord
         ON CONFLICT ${target.conflict} DO NOTHING
         RETURNING id`,
        [JSON.stringify(target.rows)],
      );

      this.counts.relationships += inserted.length;
    }
  }
}

/** An item in the batch, resolved to its staging key, plus the sightings that collapsed onto it. */
interface PlannedItem {
  key: string;
  dataSource: string;
  contentHash: string;
  item: Item;
  digest: ContentDigest | null;
  repeats: Array<{ item: Item; digest: ContentDigest | null }>;
}

/** An entity in the batch, resolved to the key it collapses on, plus every later sighting. */
interface PlannedEntity {
  key: string;
  kind: 'identity' | 'handleless';
  identityKey: string | null;
  dedupeKey: string | null;
  /** {@link entityKey}, for the handle-less cache. Null on the identity-keyed path. */
  cacheKey: string | null;
  /** The first sighting — the row — with its contact identifiers already recorded. */
  first: Entity;
  type: string | null;
  legacyIdentityKey: string | null;
  repeats: Entity[];
}

interface PlannedRelationship {
  itemKey: string;
  relation: string | null;
  metadata: Metadata | undefined;
  entityKey: string | null;
  relatedItemKey: string | null;
}

interface BatchPlan {
  items: PlannedItem[];
  entities: PlannedEntity[];
  relationships: PlannedRelationship[];
}

interface ExistingItemRow {
  id: string;
  data_source: string;
  content_hash: string;
  intermediate_location: string | null;
  content_sha256: string | null;
}

/** What a collapse is judged against: the row the duplicate landed on. */
type ExistingLike = { intermediate_location: string | null; content_sha256: string | null };

/** Every item a batch will write, including the far side of each edge. */
function collectItems(batch: Graph[]): Item[] {
  const items: Item[] = [];

  for (const graph of batch) {
    if (graph.item) {
      items.push(graph.item);
    }

    for (const edge of graph.edges ?? []) {
      if (edge.to.item) {
        items.push(edge.to.item);
      }
    }
  }

  return items;
}
