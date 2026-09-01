import { createHash } from 'node:crypto';

import type { EntityManager } from 'typeorm';

import type { Entity, Graph, ImportPipeline, Item, Metadata } from '../datasources/timeline';

import { digestFile, type ContentDigest } from './contentDigest';
import {
  dateToIso,
  entityIdentityKey,
  entityKey,
  hashItem,
  mergeAccumulatedMetadata,
  needsContentDigest,
  resolveEntityType,
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

    await this.manager.transaction(async (tx) => {
      for (const graph of batch) {
        await this.writeGraph(tx, graph, digests);
      }
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

  private async writeGraph(tx: EntityManager, graph: Graph, digests: BatchDigests): Promise<string | null> {
    const itemId = graph.item ? await this.writeItem(tx, graph.item, digests) : null;
    const entityId = graph.entity ? await this.writeEntity(tx, graph.entity) : null;

    for (const edge of graph.edges ?? []) {
      // An edge hangs off an item. A graph that carried only an entity has
      // nothing for its edges to attach to, and inventing an item to hold them
      // would stage a record the export never contained.
      if (itemId == null) {
        continue;
      }

      const targetItemId = edge.to.item ? await this.writeItem(tx, edge.to.item, digests) : null;
      const targetEntityId = edge.to.entity ? await this.writeEntity(tx, edge.to.entity) : null;

      await this.writeRelationship(tx, itemId, edge.relation, edge.metadata, {
        entityId: targetEntityId,
        relatedItemId: targetEntityId == null ? targetItemId : null,
      });
    }

    // The owner is a participant like any other, expressed as an edge so the
    // push has one shape to read rather than a special case.
    if (itemId != null && graph.item?.owner) {
      const ownerId = await this.writeEntity(tx, graph.item.owner);

      await this.writeRelationship(tx, itemId, 'owner', undefined, {
        entityId: ownerId,
        relatedItemId: null,
      });
    }

    return itemId ?? entityId;
  }

  private async writeItem(tx: EntityManager, item: Item, digests: BatchDigests): Promise<string> {
    // An item may name a different source than the importer running the job:
    // the Fitbit parser also reads the Google Fit half of one Takeout, and those
    // records are Google Fit's — they must stage (and dedup) as `google_fit`.
    const dataSource = item.dataSource ?? this.scope.dataSource;
    const digest = digests.get(item) ?? null;
    const contentHash = hashItem(item, dataSource, digest?.sha256);

    const rows = await tx.query<Array<{ id: string; inserted: boolean }>>(
      `INSERT INTO ci_import.staged_items
         (run_id, user_id, data_source, classification, content_hash, occurred_at, timespan_end,
          latitude, longitude, filename, media_type, original_location, intermediate_location, metadata,
          content_sha256, size_bytes)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::timestamptz, $7::timestamptz,
               $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16::bigint)
       ON CONFLICT (run_id, data_source, content_hash) DO NOTHING
       RETURNING id, true AS inserted`,
      [
        this.scope.runId,
        this.scope.userId,
        dataSource,
        item.classification ?? null,
        contentHash,
        // dateToIso rejects an Invalid Date (NaN getTime()) rather than
        // letting it reach the pg driver's timestamptz bind serialization --
        // hashItem already applies this same normalization to these fields,
        // this reuses it at the actual insert site.
        dateToIso(item.timestamp),
        dateToIso(item.timespanEnd),
        item.location?.latitude ?? null,
        item.location?.longitude ?? null,
        item.content?.filename ?? null,
        item.content?.mediaType ?? null,
        item.originalLocation ?? null,
        item.intermediateLocation ?? null,
        JSON.stringify(item.metadata ?? {}),
        digest?.sha256 ?? null,
        digest?.sizeBytes ?? null,
      ],
    );

    if (rows.length > 0) {
      this.counts.items += 1;

      return rows[0].id;
    }

    // `DO NOTHING` returns nothing on conflict, so the duplicate is read back.
    // This is the album-replicated photo collapsing, and it is counted rather
    // than silently swallowed — "we staged 4,000 of your 12,000 photo files" is
    // a question people ask.
    this.counts.itemsDeduped += 1;

    const existing = await tx.query<
      Array<{ id: string; intermediate_location: string | null; content_sha256: string | null }>
    >(
      `SELECT id, intermediate_location, content_sha256 FROM ci_import.staged_items
        WHERE run_id = $1::uuid AND data_source = $2 AND content_hash = $3`,
      [this.scope.runId, dataSource, contentHash],
    );

    this.recordCollapse(item, digest, existing[0]);

    return existing[0].id;
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

  private async writeEntity(tx: EntityManager, entity: Entity): Promise<string> {
    const identityKey = entityIdentityKey(entity);
    const type = resolveEntityType(entity);
    const metadata = (entity.metadata ?? {}) as Metadata;

    if (identityKey == null) {
      return this.writeHandlelessEntity(tx, entity, type, metadata);
    }

    const rows = await tx.query<Array<{ id: string; metadata: Record<string, unknown> }>>(
      `INSERT INTO ci_import.staged_entities (run_id, user_id, type, name, metadata, identity_key, data_source)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (run_id, identity_key) WHERE identity_key IS NOT NULL DO NOTHING
         RETURNING id, metadata`,
      [
        this.scope.runId,
        this.scope.userId,
        type,
        entity.name ?? null,
        JSON.stringify(metadata),
        identityKey,
        this.scope.dataSource,
      ],
    );

    if (rows.length > 0) {
      this.counts.entities += 1;

      return rows[0].id;
    }

    const existing = await tx.query<Array<{ id: string; metadata: Record<string, unknown> }>>(
      `SELECT id, metadata FROM ci_import.staged_entities
        WHERE run_id = $1::uuid AND identity_key = $2`,
      [this.scope.runId, identityKey],
    );

    await this.growEntity(tx, existing[0].id, existing[0].metadata ?? {}, entity);

    return existing[0].id;
  }

  private async writeHandlelessEntity(
    tx: EntityManager,
    entity: Entity,
    type: string | null,
    metadata: Metadata,
  ): Promise<string> {
    const key = entityKey(entity);
    // Hashed because `entityKey` embeds the attribute JSON and has no length
    // bound, while a btree index entry does.
    const dedupeKey = createHash('sha256').update(key).digest('hex');
    const seen = this.handleless.get(key);

    if (seen != null) {
      // A recurring handle-less entity still accumulates. Dishes are the whole
      // reason: an Uber Eats croissant has no phone number, so it takes this
      // path, and its price on a second morning is a fact the first sighting
      // cannot carry. Growing only the identity-keyed path silently dropped
      // every one of them.
      const rows = await tx.query<Array<{ metadata: Record<string, unknown> }>>(
        `SELECT metadata FROM ci_import.staged_entities WHERE id = $1::uuid`,
        [seen],
      );

      await this.growEntity(tx, seen, rows[0]?.metadata ?? {}, entity);

      return seen;
    }

    // ON CONFLICT against `staged_entities_run_dedupe_uniq`, mirroring the
    // identity-keyed path above. The in-process map is a cache in front of this,
    // not the dedup itself: a StagedWriter is constructed per parse ATTEMPT, so
    // a resume after a crash starts with an empty map and — before this — simply
    // re-inserted everything the dead attempt had already written.
    const rows = await tx.query<Array<{ id: string }>>(
      `INSERT INTO ci_import.staged_entities
              (run_id, user_id, type, name, metadata, identity_key, data_source, dedupe_key)
            VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, NULL, $6, $7)
         ON CONFLICT (run_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
         RETURNING id`,
      [
        this.scope.runId,
        this.scope.userId,
        type,
        entity.name ?? null,
        JSON.stringify(metadata),
        this.scope.dataSource,
        dedupeKey,
      ],
    );

    if (rows.length > 0) {
      this.counts.entities += 1;
      this.handleless.set(key, rows[0].id);

      return rows[0].id;
    }

    // A previous attempt wrote it. Read it back and accumulate onto it, exactly
    // as a repeat sighting within one attempt would — the resumed parse is
    // replaying records the dead one had already seen, and treating them as new
    // is what produced the duplicate edges alongside the duplicate rows.
    const existing = await tx.query<Array<{ id: string; metadata: Record<string, unknown> }>>(
      `SELECT id, metadata FROM ci_import.staged_entities
        WHERE run_id = $1::uuid AND dedupe_key = $2`,
      [this.scope.runId, dedupeKey],
    );

    if (existing.length === 0) {
      throw new Error('staged entity conflicted on its dedupe key but could not be read back');
    }

    await this.growEntity(tx, existing[0].id, existing[0].metadata ?? {}, entity);
    this.handleless.set(key, existing[0].id);

    return existing[0].id;
  }

  /**
   * Grow an existing entity's accumulating keys with this sighting.
   *
   * `graph_dirty` is set alongside, because the push resumes from a high-water
   * mark: a row that changed after it was already sent would otherwise never be
   * revisited.
   */
  private async growEntity(
    tx: EntityManager,
    entityId: string,
    stored: Record<string, unknown>,
    entity: Entity,
  ): Promise<void> {
    const merged = mergeAccumulatedMetadata(stored, entity);

    if (merged == null) {
      return;
    }

    await tx.query(
      `UPDATE ci_import.staged_entities
          SET metadata = $2::jsonb, graph_dirty = true
        WHERE id = $1::uuid`,
      [entityId, JSON.stringify(merged)],
    );

    this.counts.entitiesGrown += 1;
  }

  private async writeRelationship(
    tx: EntityManager,
    itemId: string,
    relation: string | null,
    metadata: Metadata | undefined,
    target: { entityId: string | null; relatedItemId: string | null },
  ): Promise<void> {
    if (target.entityId == null && target.relatedItemId == null) {
      return;
    }

    // Two partial unique indexes rather than one over both target columns, so
    // the ON CONFLICT target has to name the one that applies — a combined index
    // would read every item→item row as (item_id, NULL, relation) and collapse
    // edges pointing at different items.
    const conflictTarget =
      target.entityId != null
        ? '(item_id, entity_id, relation) WHERE entity_id IS NOT NULL'
        : '(item_id, related_item_id, relation) WHERE related_item_id IS NOT NULL';

    const rows = await tx.query<unknown[]>(
      `INSERT INTO ci_import.staged_relationships
         (run_id, item_id, entity_id, related_item_id, relation, metadata)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb)
       ON CONFLICT ${conflictTarget} DO NOTHING
       RETURNING id`,
      [
        this.scope.runId,
        itemId,
        target.entityId,
        target.relatedItemId,
        relation,
        JSON.stringify(metadata ?? {}),
      ],
    );

    if (rows.length > 0) {
      this.counts.relationships += 1;
    }
  }
}

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
